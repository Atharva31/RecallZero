// GATEWAY_MODE=spacetimedb: the real backend behind the same method surface as mock.ts.
//
// - One SpacetimeDB connection per org, with its token stored in gateway/.tokens/ (gitignored) so
//   each org keeps the same identity across gateway restarts.
// - Before calling a reducer as an org, the gateway makes sure that org is bound to its
//   connection's identity (claim_org_identity). seed_fixtures clears bindings, so this
//   re-claims automatically after a reset.
// - Every connection subscribes to all tables. Reads after a write use the writer's own
//   cache, which the SDK updates before the reducer call resolves.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DbConnection } from './module_bindings/index.ts';
import { parseReducerError } from '../../shared/contracts/reducers.ts';
import type { RecallStatus, ReportFacts, TaskWithTarget } from '../../shared/contracts/gateway.ts';
import * as rows from '../../shared/rows.ts';
import { ReducerError } from './mock.ts';
import { recallStatus, reportFacts, withTarget } from './readModel.ts';

const URI = process.env.SPACETIMEDB_URL ?? 'ws://localhost:3000';
const DB_NAME = process.env.SPACETIMEDB_DB ?? 'recallzero';
const TOKENS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.tokens');
const TOKENS_FILE = join(TOKENS_DIR, `${DB_NAME}.json`);
const READER = '__reader__';

function loadTokens(): Record<string, string> {
  try {
    return existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}
const tokens = loadTokens();
const saveToken = (key: string, token: string) => {
  if (tokens[key] === token) return;
  tokens[key] = token;
  mkdirSync(TOKENS_DIR, { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
};

/** Opens a connection and resolves once its subscription to every table is applied. */
function connect(key: string, retryWithoutToken = true): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB_NAME)
      .withToken(tokens[key])
      .onConnect((conn, _identity, token) => {
        saveToken(key, token);
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError(ctx => reject(new Error(`subscription failed for ${key}: ${ctx.event?.message ?? 'unknown'}`)))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => {
        if (tokens[key] && retryWithoutToken) {
          // Stale token (e.g. `spacetime server clear`): start over with a fresh identity.
          delete tokens[key];
          connect(key, false).then(resolve, reject);
        } else {
          reject(err);
        }
      })
      .onDisconnect(() => {
        console.warn(`spacetimedb connection for ${key} closed; it reconnects on next use`);
        conns.delete(key);
      })
      .build();
  });
}

const conns = new Map<string, Promise<DbConnection>>();
function connection(key: string): Promise<DbConnection> {
  let c = conns.get(key);
  if (!c) {
    c = connect(key);
    c.catch(() => conns.delete(key));
    conns.set(key, c);
  }
  return c;
}

function toReducerError(e: unknown): ReducerError {
  const { code, message } = parseReducerError(e instanceof Error ? e.message : String(e));
  return new ReducerError(code === 'UNKNOWN' ? 'INVALID_ARGUMENT' : code, message);
}

/** A typed snapshot of one connection's cache, in contract shapes. */
function view(conn: DbConnection) {
  const db = conn.db;
  const organizations = [...db.organizations.iter()].map(rows.toOrganization);
  const locations = [...db.locations.iter()].map(rows.toLocation);
  const target = (t: Parameters<typeof rows.toContainmentTask>[0]) =>
    withTarget(rows.toContainmentTask(t), locations, organizations);
  return {
    organizations,
    locations,
    recall: (recallId: string) => {
      const r = db.recalls.recallId.find(recallId);
      if (!r) throw new ReducerError('NOT_FOUND', `Recall ${recallId} not found`);
      return rows.toRecall(r);
    },
    recalls: () => [...db.recalls.iter()].map(rows.toRecall),
    lot: (lotId: string) => {
      const l = db.lots.lotId.find(lotId);
      if (!l) throw new ReducerError('NOT_FOUND', `Lot ${lotId} not found`);
      return rows.toLot(l);
    },
    affectedLots: (recallId: string) =>
      [...db.affectedLots.iter()].filter(a => a.recallId === recallId).map(a => a.lotId),
    affectedLocations: (recallId: string) =>
      [...db.affectedLocations.iter()].filter(a => a.recallId === recallId).map(rows.toAffectedLocation),
    task: (taskId: string): TaskWithTarget => {
      const t = db.containmentTasks.taskId.find(taskId);
      if (!t) throw new ReducerError('NOT_FOUND', `Task ${taskId} not found`);
      return target(t);
    },
    tasks: (recallId: string) => [...db.containmentTasks.iter()].filter(t => t.recallId === recallId).map(target),
    balances: (locationId: string) =>
      [...db.inventoryBalances.iter()].filter(b => b.locationId === locationId).map(rows.toInventoryBalance),
    audit: (recallId?: string) =>
      [...db.auditEvents.iter()]
        .map(rows.toAuditEvent)
        .filter(e => !recallId || e.recallId === recallId)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id),
  };
}

export async function createSpacetimeDb() {
  const reader = await connection(READER);
  const read = () => view(reader);
  const orgIds = read().organizations.map(o => o.id);

  /** The org's connection, bound to the org. Throws UNAUTHORIZED for unknown orgs. */
  async function as(orgId: string) {
    if (!read().organizations.some(o => o.id === orgId)) {
      throw new ReducerError('UNAUTHORIZED', `Unknown org ${orgId || '(missing X-Org-Id header)'}`);
    }
    const conn = await connection(orgId);
    const org = conn.db.organizations.id.find(orgId);
    if (!org?.identity || !conn.identity || !org.identity.isEqual(conn.identity)) {
      try {
        await conn.reducers.claimOrgIdentity({ orgId });
      } catch (e) {
        const err = toReducerError(e);
        if (err.code === 'UNAUTHORIZED') {
          err.message += ' (reset with `spacetime call recallzero seed_fixtures --server local` to clear bindings)';
        }
        throw err;
      }
    }
    return conn;
  }

  /** Calls a reducer as an org and returns a view of that org's (already updated) cache. */
  async function call(orgId: string, fn: (conn: DbConnection) => Promise<void>) {
    const conn = await as(orgId);
    try {
      await fn(conn);
    } catch (e) {
      throw toReducerError(e);
    }
    return view(conn);
  }

  const status = (v: ReturnType<typeof view>, recallId: string): RecallStatus =>
    recallStatus(v.recall(recallId), v.affectedLots(recallId), v.affectedLocations(recallId), v.tasks(recallId));

  // Bind every org up front so the first demo action doesn't pay for the handshake.
  await Promise.allSettled(orgIds.map(as));

  return {
    get organizations() {
      return read().organizations;
    },
    getLot: (lotId: string) => read().lot(lotId),
    listRecalls: () => read().recalls(),

    async reportRecallSignal(orgId: string, rootLotId: string, reason: string) {
      const v = await call(orgId, c => c.reducers.reportRecallSignal({ rootLotId, reason }));
      // Reducers return nothing: the new recall is the newest open one for this lot.
      const recall = v
        .recalls()
        .filter(r => r.rootLotId === rootLotId && r.status === 'SIGNAL')
        .sort((a, b) => b.recallId.localeCompare(a.recallId))[0];
      return recall;
    },
    async authorizeRecall(orgId: string, recallId: string) {
      return (await call(orgId, c => c.reducers.authorizeRecall({ recallId }))).recall(recallId);
    },
    async traceRecall(orgId: string, recallId: string) {
      const v = await call(orgId, c => c.reducers.traceRecall({ recallId }));
      return { recall: v.recall(recallId), affectedLots: v.affectedLots(recallId), affectedLocations: v.affectedLocations(recallId) };
    },
    async assignContainmentTasks(orgId: string, recallId: string) {
      const v = await call(orgId, c => c.reducers.assignContainmentTasks({ recallId }));
      return { recall: v.recall(recallId), tasks: v.tasks(recallId) };
    },
    getRecallStatus: (recallId: string) => status(read(), recallId),
    getReportFacts: (recallId: string): ReportFacts => reportFacts(status(read(), recallId), new Date().toISOString()),
    async closeRecall(orgId: string, recallId: string, note: string) {
      return (await call(orgId, c => c.reducers.closeRecall({ recallId, note: note ?? '' }))).recall(recallId);
    },
    getTask: (taskId: string) => read().task(taskId),
    async claimTask(orgId: string, taskId: string) {
      return (await call(orgId, c => c.reducers.claimTask({ taskId }))).task(taskId);
    },
    async quarantineLot(orgId: string, taskId: string) {
      const v = await call(orgId, c => c.reducers.quarantineLot({ taskId }));
      const task = v.task(taskId);
      const affectedLocation = v.affectedLocations(task.recallId).find(a => a.locationId === task.locationId)!;
      return { task, affectedLocation, quarantinedUnits: affectedLocation.quarantinedUnits };
    },
    getInventory: (locationId: string) => read().balances(locationId),
    async recordSale(orgId: string, locationId: string, lotId: string, qty: number) {
      if (!Number.isInteger(qty) || qty <= 0) throw new ReducerError('INVALID_ARGUMENT', 'qty must be a positive whole number');
      const v = await call(orgId, c => c.reducers.recordSale({ locationId, lotId, qty }));
      return v.balances(locationId).find(b => b.lotId === lotId)!;
    },
    getAudit: (recallId?: string) => read().audit(recallId),
  };
}
