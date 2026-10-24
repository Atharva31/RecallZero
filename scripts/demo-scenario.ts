// Runs the PLAN.md section 12 demo flow end to end through the gateway, checking every beat.
// Exit code 0 only if every check passes, so it doubles as the end-to-end test.
//
//   node scripts/demo-scenario.ts                # no agents: this script plays Store A's agent
//   node scripts/demo-scenario.ts --agents       # coordinator + Store A agent running, Store B agent killed
//   node scripts/demo-scenario.ts --pace 2500    # pause between beats so the UI can be watched
//   node scripts/demo-scenario.ts --no-reset     # skip reset.ts first
//   node scripts/demo-scenario.ts --no-manual    # leave the MANUAL stores (C, D, E) unconfirmed
//
// Needs `spacetime start` and the gateway with GATEWAY_MODE=spacetimedb. Store B is never answered,
// so it escalates after 3 lease windows (~60 s): that wait is most of the run time.

import type { ReportFacts, RecallStatus, TaskWithTarget } from '../shared/contracts/gateway.ts';
import type { AffectedLocation, InventoryBalance, LotEdge, Recall } from '../shared/contracts/tables.ts';
import { TASK_LEASE_MS, TASK_MAX_RETRIES } from '../shared/contracts/tables.ts';
import { reset } from './reset.ts';
import {
  amber,
  argValue,
  args,
  check,
  dim,
  fixture,
  green,
  gw,
  gwOk,
  info,
  portOpen,
  red,
  sameSet,
  sleep,
  step,
  waitFor,
} from './lib.ts';

const ACME = 'ORG-ACME';
const ROOT_LOT = 'PEANUT-009';
const REASON = 'Salmonella detected in supplier lot PEANUT-009';
const AFFECTED_LOTS = ['BAR-100', 'BAR-101'];
const AFFECTED_STORES = ['STORE-A', 'STORE-B', 'STORE-C', 'STORE-D', 'STORE-E'];
const MANUAL_STORES = ['STORE-C', 'STORE-D', 'STORE-E'];
/** Agent ports (agents/shared/peers.py). */
const PORTS = { coordinator: 8001, storeA: 8002, storeB: 8003 };

export interface ScenarioOptions {
  reset?: boolean;
  agents?: boolean;
  manual?: boolean;
  paceMs?: number;
}

const orgOf = (locationId: string) => `ORG-${locationId}`;
const status = (recallId: string) => gwOk<RecallStatus>('GET', `/recalls/${recallId}/status`);
const locationIn = (s: RecallStatus, id: string) => s.affectedLocations.find(a => a.locationId === id);

function colorStatus(st: string) {
  if (st === 'VERIFIED_CONTAINED') return green(st);
  if (st === 'AWAITING_ACKNOWLEDGMENT') return amber(st);
  return red(st);
}

function printTable(locs: AffectedLocation[]) {
  console.log(dim('    location   status                     expected  sold  quarantined  lost  unaccounted'));
  for (const a of [...locs].sort((x, y) => x.locationId.localeCompare(y.locationId))) {
    const pad = (v: number, n: number) => String(v).padStart(n);
    console.log(
      `    ${a.locationId.padEnd(10)} ${colorStatus(a.status.padEnd(26))} ${pad(a.expectedUnits, 8)} ${pad(a.soldUnits, 5)} ${pad(
        a.quarantinedUnits,
        12
      )} ${pad(a.lostInTransitUnits, 5)} ${pad(a.unaccountedUnits, 12)}`
    );
  }
}

async function preflight(agents: boolean) {
  step('Preflight');
  const coordinator = await portOpen(PORTS.coordinator);
  const storeA = await portOpen(PORTS.storeA);
  const storeB = await portOpen(PORTS.storeB);
  if (agents) {
    check(coordinator, `coordinator agent is listening on :${PORTS.coordinator}`);
    check(storeA, `Store A agent is listening on :${PORTS.storeA}`);
    check(!storeB, `Store B agent is down (killed for the escalation beat)`);
  } else {
    check(
      !coordinator && !storeA && !storeB,
      'no agents running (they would answer Store A/B themselves; use --agents instead)',
      { coordinator, storeA, storeB }
    );
  }
}

export async function runScenario(opts: ScenarioOptions = {}): Promise<ReportFacts> {
  const { agents = false, manual = true, paceMs = 0 } = opts;
  const pace = () => (paceMs ? sleep(paceMs) : Promise.resolve());
  const t0 = Date.now();
  const elapsed = () => dim(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`);

  await preflight(agents);
  if (opts.reset !== false) await reset();

  // 0:00 Two different bars share one peanut lot.
  step(`${elapsed()} 0:00 The graph: two bars share one peanut lot`);
  const edges = fixture<LotEdge[]>('lot_edges');
  for (const e of edges) info(`${e.parentLotId} → ${e.childLotId} (${e.quantityUsed} kg)`);
  const lot = await gwOk<{ lot: { lotId: string; kind: string } }>('GET', `/lots/${ROOT_LOT}`);
  check(lot.lot.kind === 'INGREDIENT', `${ROOT_LOT} exists and is an ingredient lot`);
  await pace();

  // 0:25 Start the investigation (what the coordinator / fallback button does).
  step(`${elapsed()} 0:25 Start recall for ${ROOT_LOT} as ${ACME}`);
  const { recall } = await gwOk<{ recall: Recall }>('POST', '/recalls', ACME, { rootLotId: ROOT_LOT, reason: REASON });
  const rid = recall.recallId;
  check(recall.status === 'SIGNAL', `${rid} reported (SIGNAL)`);
  check((await gwOk<{ recall: Recall }>('POST', `/recalls/${rid}/authorize`, ACME)).recall.status === 'AUTHORIZED', `${rid} AUTHORIZED`);

  const traced = await gwOk<{ recall: Recall; affectedLots: string[]; affectedLocations: AffectedLocation[] }>(
    'POST',
    `/recalls/${rid}/trace`,
    ACME
  );
  const tracedIds = traced.affectedLocations.map(a => a.locationId);
  check(traced.recall.status === 'TRACED', `${rid} TRACED`);
  check(sameSet(traced.affectedLots, AFFECTED_LOTS), `affected lots: ${traced.affectedLots.sort().join(', ')}`);
  check(!traced.affectedLots.includes('BAR-102'), 'BAR-102 (Oat Honey Bar) not affected');
  check(sameSet(tracedIds, AFFECTED_STORES), `affected locations: ${tracedIds.sort().join(', ')}`);
  check(!tracedIds.includes('STORE-F'), 'Store F stays untouched');
  const d = traced.affectedLocations.find(a => a.locationId === 'STORE-D');
  check(
    d?.status === 'RECONCILIATION_EXCEPTION' && d.unaccountedUnits === 15 && d.lostInTransitUnits === 10,
    'Store D: 10 lost in transit, 15 unaccounted → RECONCILIATION_EXCEPTION',
    d
  );

  const { tasks } = await gwOk<{ recall: Recall; tasks: TaskWithTarget[] }>('POST', `/recalls/${rid}/assign`, ACME);
  const taskAt = (id: string) => tasks.find(t => t.locationId === id)!;
  check(sameSet(tasks.map(t => t.locationId), AFFECTED_STORES), `${tasks.length} containment tasks assigned → CONTAINING`);
  for (const t of tasks) info(`${t.taskId} → ${t.locationId} (${t.integrationLevel}) lots ${t.lotIds.join(', ')}`);

  // Identity is the caller's own org connection (ctx.sender), never an argument.
  step(`${elapsed()} Permissions: orgs can only act on what they own`);
  const denied: [string, 'GET' | 'POST', string, string, unknown?][] = [
    ['Store B cannot claim Store A’s task', 'POST', `/tasks/${taskAt('STORE-A').taskId}/claim`, 'ORG-STORE-B'],
    ['Store A cannot quarantine Store B’s task', 'POST', `/tasks/${taskAt('STORE-B').taskId}/quarantine`, 'ORG-STORE-A'],
    ['Store A cannot sell at Store F', 'POST', '/sales', 'ORG-STORE-A', { locationId: 'STORE-F', lotId: 'BAR-102', qty: 1 }],
    ['a retailer cannot close the recall', 'POST', `/recalls/${rid}/close`, 'ORG-STORE-A', { note: 'nope' }],
    ['an unknown org is rejected', 'POST', `/tasks/${taskAt('STORE-A').taskId}/claim`, 'ORG-NOBODY'],
  ];
  for (const [what, method, path, org, body] of denied) {
    const r = await gw(method, path, org, body);
    check(r.status === 403 && !r.body.ok && r.body.error.code === 'UNAUTHORIZED', `${what} (403 UNAUTHORIZED)`, r.body);
  }
  const untouched = await status(rid);
  check(
    untouched.tasks.every(t => t.state === 'PENDING') && untouched.coverage.quarantinedUnits === 0,
    'rejected calls changed nothing'
  );
  await pace();

  // 0:55 Agents work; Store A turns green.
  const a = taskAt('STORE-A');
  if (agents) {
    step(`${elapsed()} 0:55 Waiting for the coordinator to dispatch the Store A agent`);
    await waitFor('Store A VERIFIED_CONTAINED by its agent', async () => locationIn(await status(rid), 'STORE-A')?.status === 'VERIFIED_CONTAINED', {
      timeoutMs: 45_000,
    });
  } else {
    step(`${elapsed()} 0:55 Store A agent (played by this script): claim → quarantine`);
    await gwOk('POST', `/tasks/${a.taskId}/claim`, 'ORG-STORE-A');
    const q = await gwOk<{ affectedLocation: AffectedLocation; quarantinedUnits: number }>(
      'POST',
      `/tasks/${a.taskId}/quarantine`,
      'ORG-STORE-A'
    );
    info(`committed: ${q.affectedLocation.status}, ${q.quarantinedUnits} units quarantined`);
  }
  const storeA = locationIn(await status(rid), 'STORE-A');
  check(storeA?.status === 'VERIFIED_CONTAINED' && storeA.quarantinedUnits === 120, 'Store A VERIFIED_CONTAINED, 120 units quarantined');

  if (manual) {
    step(`${elapsed()} Manual stores confirm on the store terminal`);
    for (const id of MANUAL_STORES) {
      const q = await gwOk<{ affectedLocation: AffectedLocation }>('POST', `/tasks/${taskAt(id).taskId}/quarantine`, orgOf(id));
      info(`${id}: ${q.affectedLocation.status}, ${q.affectedLocation.quarantinedUnits} quarantined`);
    }
    const s = await status(rid);
    check(locationIn(s, 'STORE-C')?.status === 'VERIFIED_CONTAINED', 'Store C VERIFIED_CONTAINED');
    check(locationIn(s, 'STORE-E')?.status === 'VERIFIED_CONTAINED', 'Store E VERIFIED_CONTAINED');
    check(
      locationIn(s, 'STORE-D')?.status === 'RECONCILIATION_EXCEPTION',
      'Store D quarantined its 20 units but stays RECONCILIATION_EXCEPTION (15 still unaccounted)'
    );
  }
  await pace();

  // 1:25 POS: quarantined lot blocked, unaffected lot sells.
  step(`${elapsed()} 1:25 Store terminals: point of sale`);
  const blocked = await gw('POST', '/sales', 'ORG-STORE-A', { locationId: 'STORE-A', lotId: 'BAR-100', qty: 1 });
  const err = blocked.body.ok ? null : blocked.body.error;
  check(
    blocked.status === 409 && err?.code === 'LOT_QUARANTINED' && err.message === `Sale blocked: lot BAR-100 under recall ${rid}`,
    `Store A sell BAR-100 → ${blocked.status} "${err?.message}"`,
    blocked.body
  );
  const sold = await gwOk<{ balance: InventoryBalance }>('POST', '/sales', 'ORG-STORE-F', { locationId: 'STORE-F', lotId: 'BAR-102', qty: 1 });
  check(sold.balance.available === 149, `Store F sell BAR-102 → ok (${sold.balance.available} left)`);
  await pace();

  // 1:55 Store B's agent is dead: lease windows expire, task escalates, location becomes unknown.
  const b = taskAt('STORE-B');
  const windows = TASK_MAX_RETRIES + 1;
  step(`${elapsed()} 1:55 Store B never answers: ${windows} × ${TASK_LEASE_MS / 1000}s lease windows, then escalation`);
  let last = '';
  const escalated = await waitFor(
    `${b.taskId} ESCALATED`,
    async () => {
      const s = await status(rid);
      const t = s.tasks.find(x => x.taskId === b.taskId)!;
      const now = `${t.state} (attempt ${t.attempts})`;
      if (now !== last) info(`${elapsed()} ${b.taskId}: ${now}`);
      last = now;
      return t.state === 'ESCALATED' ? s : null;
    },
    { timeoutMs: windows * TASK_LEASE_MS + 30_000, intervalMs: 1_000 }
  );
  check(locationIn(escalated, 'STORE-B')?.status === 'INVENTORY_UNKNOWN', 'Store B INVENTORY_UNKNOWN (not assumed contained)');
  check(locationIn(escalated, 'STORE-B')?.quarantinedUnits === 0, 'Store B: 0 units claimed as quarantined');
  await pace();

  // 2:25 Final report from committed facts.
  step(`${elapsed()} 2:25 Final report (committed facts only)`);
  const final = await status(rid);
  printTable(final.affectedLocations);
  const { facts } = await gwOk<{ facts: ReportFacts }>('GET', `/recalls/${rid}/report`);
  const c = facts.coverage;
  info(
    `location coverage ${(c.locationCoverage * 100).toFixed(0)}% (${c.verifiedLocations}/${c.affectedLocations}), ` +
      `unit coverage ${(c.unitCoverage * 100).toFixed(0)}% (${c.quarantinedUnits}/${c.knownUnsoldUnits} known unsold)`
  );
  const verified = facts.verified.map(v => v.locationId);
  check(sameSet(verified, manual ? ['STORE-A', 'STORE-C', 'STORE-E'] : ['STORE-A']), `verified: ${verified.sort().join(', ')}`);
  check(facts.unaccounted.some(u => u.locationId === 'STORE-D' && u.units === 15), 'unaccounted: STORE-D 15');
  check(facts.lostInTransit.some(u => u.locationId === 'STORE-D' && u.units === 10), 'lost in transit: STORE-D 10');
  check(facts.unknown.some(u => u.locationId === 'STORE-B' && u.status === 'INVENTORY_UNKNOWN'), 'unknown: STORE-B');
  check(facts.escalated.some(e => e.locationId === 'STORE-B' && e.attempts === windows), `escalated: STORE-B after ${windows} attempts`);
  check(final.settled, 'recall settled (every connected store verified or escalated)');

  const close = await gw('POST', `/recalls/${rid}/close`, ACME, { note: 'Demo close attempt' });
  check(
    !close.body.ok && close.body.error.code === 'CANNOT_CLOSE',
    `close refused: ${close.body.ok ? 'closed!' : close.body.error.message}`
  );
  info('"We don\'t claim containment we can\'t prove."');
  console.log(`\n${green('Demo scenario passed')} ${elapsed()}`);
  return facts;
}

if (import.meta.main) {
  try {
    await runScenario({
      reset: !args.has('--no-reset'),
      agents: args.has('--agents'),
      manual: !args.has('--no-manual'),
      paceMs: Number(argValue('--pace') ?? 0),
    });
  } catch (e) {
    console.error(red(`\n${(e as Error).message}`));
    process.exit(1);
  }
}
