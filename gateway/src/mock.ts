// In-memory mock of the database, built from fixtures/. Lets agents run the full
// flow before the real SpacetimeDB reducers exist. Mirrors reducer behaviour
// loosely; the real rules live in spacetimedb/. Replace with SpacetimeDB calls
// behind the same functions (see routes.ts).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AffectedLocation,
  AuditEvent,
  ContainmentTask,
  InventoryBalance,
  Location,
  Lot,
  LotEdge,
  Organization,
  Recall,
  Shipment,
  ShipmentLine,
} from '../../shared/contracts/tables.ts';
import { TASK_LEASE_MS, TASK_MAX_RETRIES, TIMEOUT_CHECK_INTERVAL_MS } from '../../shared/contracts/tables.ts';
import type { ErrorCode } from '../../shared/contracts/reducers.ts';
import type { Coverage, RecallStatus, ReportFacts, TaskWithTarget } from '../../shared/contracts/gateway.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

export class ReducerError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

const now = () => new Date().toISOString();

export function createMockDb() {
  const organizations = load<Omit<Organization, 'identity'>[]>('organizations').map(o => ({ ...o, identity: null }) as Organization);
  const locations = load<Location[]>('locations');
  const lots = load<Lot[]>('lots');
  const lotEdges = load<LotEdge[]>('lot_edges');
  const shipments = load<Shipment[]>('shipments');
  const shipmentLines = load<ShipmentLine[]>('shipment_lines');
  const balances = load<InventoryBalance[]>('inventory_balances');

  const recalls: Recall[] = [];
  const affectedLots = new Map<string, string[]>();
  const affectedLocations: AffectedLocation[] = [];
  const tasks: ContainmentTask[] = [];
  const audit: AuditEvent[] = [];

  const org = (id: string) => {
    const o = organizations.find(o => o.id === id);
    if (!o) throw new ReducerError('UNAUTHORIZED', `Unknown org ${id}`);
    return o;
  };
  const requireRole = (orgId: string, ...types: Organization['type'][]) => {
    const o = org(orgId);
    if (!types.includes(o.type)) throw new ReducerError('UNAUTHORIZED', `${orgId} (${o.type}) may not do this`);
    return o;
  };
  const recall = (id: string) => {
    const r = recalls.find(r => r.recallId === id);
    if (!r) throw new ReducerError('NOT_FOUND', `Recall ${id} not found`);
    return r;
  };
  const task = (id: string) => {
    const t = tasks.find(t => t.taskId === id);
    if (!t) throw new ReducerError('NOT_FOUND', `Task ${id} not found`);
    return t;
  };
  const location = (id: string) => locations.find(l => l.id === id)!;
  const balance = (lotId: string, locationId: string) => balances.find(b => b.lotId === lotId && b.locationId === locationId);
  const log = (recallId: string | null, actor: string, action: string, detail: string) =>
    audit.push({ id: audit.length + 1, recallId, actor, action, detail, at: now() });

  const withTarget = (t: ContainmentTask): TaskWithTarget => {
    const o = org(location(t.locationId).orgId);
    return { ...t, orgId: o.id, integrationLevel: o.integrationLevel };
  };

  function coverage(recallId: string): Coverage {
    const locs = affectedLocations.filter(a => a.recallId === recallId);
    const verified = locs.filter(a => a.status === 'VERIFIED_CONTAINED');
    const quarantinedUnits = locs.reduce((s, a) => s + a.quarantinedUnits, 0);
    const knownUnsoldUnits = locs.reduce(
      (s, a) => s + Math.max(0, a.expectedUnits - a.soldUnits - a.unaccountedUnits),
      0,
    );
    return {
      affectedLocations: locs.length,
      verifiedLocations: verified.length,
      awaitingLocations: locs.filter(a => a.status === 'AWAITING_ACKNOWLEDGMENT').length,
      exceptionLocations: locs.length - verified.length - locs.filter(a => a.status === 'AWAITING_ACKNOWLEDGMENT').length,
      locationCoverage: locs.length ? verified.length / locs.length : 0,
      quarantinedUnits,
      knownUnsoldUnits,
      unitCoverage: knownUnsoldUnits ? quarantinedUnits / knownUnsoldUnits : 0,
    };
  }

  /**
   * Expire leases, as check_task_timeouts will. Runs every 5 s and on reads.
   * attempts = lease windows started. CONNECTED tasks get a lease on assignment, so a
   * dead agent that never claims still times out: 1 + TASK_MAX_RETRIES windows, then ESCALATED.
   */
  function checkTimeouts() {
    const t0 = Date.now();
    for (const t of tasks) {
      if (t.state === 'VERIFIED' || t.state === 'ESCALATED' || !t.leaseExpiresAt || Date.parse(t.leaseExpiresAt) > t0) continue;
      if (t.attempts > TASK_MAX_RETRIES) {
        t.state = 'ESCALATED';
        t.leaseExpiresAt = null;
        const a = affectedLocations.find(a => a.recallId === t.recallId && a.locationId === t.locationId)!;
        if (a.status !== 'VERIFIED_CONTAINED') a.status = 'INVENTORY_UNKNOWN';
        log(t.recallId, 'system', 'check_task_timeouts', `${t.taskId} escalated after ${t.attempts} attempts; ${t.locationId} INVENTORY_UNKNOWN`);
      } else {
        log(t.recallId, 'system', 'check_task_timeouts', `${t.taskId} timed out (attempt ${t.attempts}), retry pending`);
        t.state = 'RETRY_PENDING';
        t.attempts += 1;
        t.leaseExpiresAt = new Date(t0 + TASK_LEASE_MS).toISOString();
      }
    }
  }

  // Mirrors the check_task_timeouts scheduled reducer.
  setInterval(checkTimeouts, TIMEOUT_CHECK_INTERVAL_MS).unref();

  function status(recallId: string): RecallStatus {
    checkTimeouts();
    const r = recall(recallId);
    const locs = affectedLocations.filter(a => a.recallId === recallId);
    const ts = tasks.filter(t => t.recallId === recallId).map(withTarget);
    const settled =
      ts.length > 0 && ts.every(t => t.state === 'VERIFIED' || t.state === 'ESCALATED' || t.integrationLevel === 'MANUAL') &&
      locs.every(a => a.status !== 'AWAITING_ACKNOWLEDGMENT' || org(location(a.locationId).orgId).integrationLevel === 'MANUAL');
    return { recall: r, affectedLots: affectedLots.get(recallId) ?? [], affectedLocations: locs, tasks: ts, coverage: coverage(recallId), settled };
  }

  return {
    organizations,
    getLot(lotId: string) {
      const l = lots.find(l => l.lotId === lotId);
      if (!l) throw new ReducerError('NOT_FOUND', `Lot ${lotId} not found`);
      return l;
    },

    reportRecallSignal(orgId: string, rootLotId: string, reason: string) {
      requireRole(orgId, 'MANUFACTURER');
      this.getLot(rootLotId);
      const r: Recall = {
        recallId: `REC-${String(recalls.length + 1).padStart(3, '0')}`,
        rootLotId,
        reason,
        status: 'SIGNAL',
        createdBy: orgId,
        createdAt: now(),
      };
      recalls.push(r);
      log(r.recallId, orgId, 'report_recall_signal', `Signal for ${rootLotId}: ${reason}`);
      return r;
    },

    authorizeRecall(orgId: string, recallId: string) {
      requireRole(orgId, 'MANUFACTURER');
      const r = recall(recallId);
      if (r.status !== 'SIGNAL') throw new ReducerError('INVALID_STATE', `${recallId} is ${r.status}, expected SIGNAL`);
      r.status = 'AUTHORIZED';
      log(recallId, orgId, 'authorize_recall', `${recallId} authorized`);
      return r;
    },

    /** Mock trace: BFS lot edges, then shipments. Only STORE locations are affected in the mock. */
    traceRecall(orgId: string, recallId: string) {
      requireRole(orgId, 'MANUFACTURER');
      const r = recall(recallId);
      if (r.status !== 'AUTHORIZED') throw new ReducerError('INVALID_STATE', `${recallId} is ${r.status}, expected AUTHORIZED`);
      const seen = new Set([r.rootLotId]);
      const queue = [r.rootLotId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of lotEdges) if (e.parentLotId === cur && !seen.has(e.childLotId)) seen.add(e.childLotId), queue.push(e.childLotId);
      }
      const finished = [...seen].filter(id => lots.find(l => l.lotId === id)?.kind === 'FINISHED');
      affectedLots.set(recallId, finished);
      for (const sl of shipmentLines.filter(sl => finished.includes(sl.lotId))) {
        const sh = shipments.find(s => s.shipmentId === sl.shipmentId)!;
        if (location(sh.toLocation).type !== 'STORE') continue;
        const b = balance(sl.lotId, sh.toLocation);
        const sold = b?.sold ?? 0;
        const onHand = b?.available ?? 0;
        const unaccounted = Math.max(0, sl.qtyReceived - sold - onHand);
        affectedLocations.push({
          recallId,
          locationId: sh.toLocation,
          status: unaccounted > 0 ? 'RECONCILIATION_EXCEPTION' : 'AWAITING_ACKNOWLEDGMENT',
          expectedUnits: sl.qtyReceived,
          soldUnits: sold,
          quarantinedUnits: 0,
          unaccountedUnits: unaccounted,
          lostInTransitUnits: sl.qtyDispatched - sl.qtyReceived,
          dispositionNote: null,
        });
      }
      r.status = 'TRACED';
      log(recallId, orgId, 'trace_recall', `Affected lots ${finished.join(', ')}; ${affectedLocations.filter(a => a.recallId === recallId).length} locations`);
      return { recall: r, affectedLots: finished, affectedLocations: affectedLocations.filter(a => a.recallId === recallId) };
    },

    assignContainmentTasks(orgId: string, recallId: string) {
      requireRole(orgId, 'MANUFACTURER');
      const r = recall(recallId);
      if (r.status !== 'TRACED') throw new ReducerError('INVALID_STATE', `${recallId} is ${r.status}, expected TRACED`);
      const lotIds = affectedLots.get(recallId) ?? [];
      for (const a of affectedLocations.filter(a => a.recallId === recallId)) {
        const connected = org(location(a.locationId).orgId).integrationLevel === 'CONNECTED';
        tasks.push({
          taskId: `T-${tasks.length + 1}`,
          recallId,
          locationId: a.locationId,
          lotIds: lotIds.filter(l => balance(l, a.locationId)),
          state: 'PENDING',
          attempts: connected ? 1 : 0,
          leaseExpiresAt: connected ? new Date(Date.now() + TASK_LEASE_MS).toISOString() : null,
          dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      r.status = 'CONTAINING';
      log(recallId, orgId, 'assign_containment_tasks', `${tasks.filter(t => t.recallId === recallId).length} tasks assigned`);
      return { recall: r, tasks: tasks.filter(t => t.recallId === recallId).map(withTarget) };
    },

    getTask: (taskId: string) => withTarget(task(taskId)),

    claimTask(orgId: string, taskId: string) {
      checkTimeouts();
      const t = task(taskId);
      if (location(t.locationId).orgId !== orgId) throw new ReducerError('UNAUTHORIZED', `${orgId} does not own ${t.locationId}`);
      if (t.state === 'VERIFIED' || t.state === 'ESCALATED') throw new ReducerError('INVALID_STATE', `${taskId} is ${t.state}`);
      if (t.state === 'CLAIMED' || t.state === 'IN_PROGRESS') throw new ReducerError('LEASE_HELD', `${taskId} already claimed`);
      t.state = 'CLAIMED';
      if (t.attempts === 0) t.attempts = 1; // MANUAL tasks start without a lease window
      t.leaseExpiresAt = new Date(Date.now() + TASK_LEASE_MS).toISOString();
      log(t.recallId, orgId, 'claim_task', `${taskId} claimed by ${orgId} (attempt ${t.attempts})`);
      return withTarget(t);
    },

    quarantineLot(orgId: string, taskId: string) {
      const t = task(taskId);
      if (location(t.locationId).orgId !== orgId) throw new ReducerError('UNAUTHORIZED', `${orgId} does not own ${t.locationId}`);
      const a = affectedLocations.find(a => a.recallId === t.recallId && a.locationId === t.locationId)!;
      if (t.state !== 'VERIFIED') {
        if (t.state === 'ESCALATED') throw new ReducerError('INVALID_STATE', `${taskId} already escalated`);
        let moved = 0;
        for (const lotId of t.lotIds) {
          const b = balance(lotId, t.locationId);
          if (!b) continue;
          moved += b.available;
          b.quarantined += b.available;
          b.available = 0;
        }
        a.quarantinedUnits += moved;
        if (a.status !== 'RECONCILIATION_EXCEPTION') a.status = 'VERIFIED_CONTAINED';
        t.state = 'VERIFIED';
        t.leaseExpiresAt = null;
        log(t.recallId, orgId, 'quarantine_lot', `${t.locationId}: ${moved} units of ${t.lotIds.join(', ')} quarantined`);
      }
      return { task: withTarget(t), affectedLocation: a, quarantinedUnits: a.quarantinedUnits };
    },

    getRecallStatus: status,

    getReportFacts(recallId: string): ReportFacts {
      const s = status(recallId);
      const locs = s.affectedLocations;
      return {
        recallId,
        rootLotId: s.recall.rootLotId,
        reason: s.recall.reason,
        affectedLots: s.affectedLots,
        coverage: s.coverage,
        verified: locs.filter(a => a.status === 'VERIFIED_CONTAINED').map(a => ({ locationId: a.locationId, quarantinedUnits: a.quarantinedUnits })),
        soldBeforeRecall: locs.filter(a => a.soldUnits > 0).map(a => ({ locationId: a.locationId, units: a.soldUnits })),
        lostInTransit: locs.filter(a => a.lostInTransitUnits > 0).map(a => ({ locationId: a.locationId, units: a.lostInTransitUnits })),
        unaccounted: locs.filter(a => a.unaccountedUnits > 0).map(a => ({ locationId: a.locationId, units: a.unaccountedUnits })),
        unknown: locs
          .filter(a => a.status === 'INVENTORY_UNKNOWN' || a.status === 'AWAITING_ACKNOWLEDGMENT')
          .map(a => ({ locationId: a.locationId, status: a.status })),
        escalated: s.tasks.filter(t => t.state === 'ESCALATED').map(t => ({ locationId: t.locationId, taskId: t.taskId, attempts: t.attempts })),
        generatedAt: now(),
      };
    },

    closeRecall(orgId: string, recallId: string, note: string) {
      requireRole(orgId, 'MANUFACTURER');
      const r = recall(recallId);
      const open = affectedLocations.filter(a => a.recallId === recallId && a.status !== 'VERIFIED_CONTAINED' && !a.dispositionNote);
      if (open.length) throw new ReducerError('CANNOT_CLOSE', `Unverified without disposition: ${open.map(a => a.locationId).join(', ')}`);
      r.status = 'CLOSED';
      log(recallId, orgId, 'close_recall', note);
      return r;
    },

    getInventory: (locationId: string) => balances.filter(b => b.locationId === locationId),

    recordSale(orgId: string, locationId: string, lotId: string, qty: number) {
      requireRole(orgId, 'RETAILER');
      if (location(locationId)?.orgId !== orgId) throw new ReducerError('UNAUTHORIZED', `${orgId} does not own ${locationId}`);
      const b = balance(lotId, locationId);
      if (!b) throw new ReducerError('NOT_FOUND', `No stock of ${lotId} at ${locationId}`);
      if (b.quarantined > 0) {
        const t = tasks.find(t => t.locationId === locationId && t.lotIds.includes(lotId));
        throw new ReducerError('LOT_QUARANTINED', `Sale blocked: lot ${lotId} under recall ${t?.recallId ?? 'unknown'}`);
      }
      if (b.available < qty) throw new ReducerError('INSUFFICIENT_STOCK', `Only ${b.available} of ${lotId} available`);
      b.available -= qty;
      b.sold += qty;
      return b;
    },

    getAudit: (recallId?: string) => audit.filter(e => !recallId || e.recallId === recallId),
  };
}

export type MockDb = ReturnType<typeof createMockDb>;
