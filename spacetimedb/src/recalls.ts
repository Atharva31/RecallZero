// Recall lifecycle: SIGNAL -> AUTHORIZED -> TRACED -> CONTAINING -> CLOSED,
// plus the affected_locations bookkeeping shared with tasks and sales.

import { t } from 'spacetimedb/server';

import spacetimedb from './schema';
import { audit } from './audit';
import {
  contractBalancesAt,
  contractEventsAt,
  contractLocations,
  contractLotEdges,
  contractLots,
  contractShipmentLines,
  contractShipments,
  fail,
  plusMs,
  type Ctx,
} from './common';
import { requireRole } from './permissions';
import { traceDownstream } from './trace';
import { reconcileLocation } from './reconcile';
import { TASK_LEASE_MS, type AffectedLocationStatus, type RecallStatus } from '../../shared/contracts/tables';

/** How long a containment task has before it is overdue (shown in the UI, not enforced). */
const TASK_DUE_MS = 10 * 60_000;

export function requireRecall(ctx: Ctx, recallId: string) {
  const recall = ctx.db.recalls.recallId.find(recallId);
  if (!recall) fail('NOT_FOUND', `Recall ${recallId} not found`);
  return recall;
}

function requireStatus(recall: { recallId: string; status: string }, ...expected: RecallStatus[]) {
  if (!expected.includes(recall.status as RecallStatus)) {
    fail('INVALID_STATE', `${recall.recallId} is ${recall.status}, expected ${expected.join(' or ')}`);
  }
}

export function affectedLotIds(ctx: Ctx, recallId: string): string[] {
  return [...ctx.db.affectedLots.recallId.filter(recallId)].map(a => a.lotId);
}

export function findAffectedLocation(ctx: Ctx, recallId: string, locationId: string) {
  return [...ctx.db.affectedLocations.recallId.filter(recallId)].find(a => a.locationId === locationId);
}

type AffectedLocationRow = NonNullable<ReturnType<typeof findAffectedLocation>>;

function reconcile(ctx: Ctx, locationId: string, lotIds: string[]) {
  return reconcileLocation({
    locationId,
    lotIds,
    shipments: contractShipments(ctx),
    shipmentLines: contractShipmentLines(ctx),
    events: contractEventsAt(ctx, locationId, lotIds),
    balances: contractBalancesAt(ctx, locationId, lotIds),
  });
}

/** Statuses that a newly found discrepancy overrides. Unknown / failed stay as they are. */
const RECONCILABLE: AffectedLocationStatus[] = ['AWAITING_ACKNOWLEDGMENT', 'VERIFIED_CONTAINED', 'PARTIALLY_CONTAINED'];

/**
 * Recomputes an affected location's numbers from committed events and balances.
 * Unaccounted units never decrease (a recorded discrepancy stays on record).
 * Returns the updated row.
 */
export function reconcileAffectedLocation(ctx: Ctx, row: AffectedLocationRow, actor: string): AffectedLocationRow {
  const r = reconcile(ctx, row.locationId, affectedLotIds(ctx, row.recallId));
  const unaccountedUnits = Math.max(row.unaccountedUnits, r.unaccountedUnits);
  let status = row.status;
  if (unaccountedUnits > 0 && RECONCILABLE.includes(status as AffectedLocationStatus)) {
    status = 'RECONCILIATION_EXCEPTION';
    audit(
      ctx,
      row.recallId,
      actor,
      'record_discrepancy',
      `${row.locationId}: received ${r.expectedUnits}, sold ${r.soldUnits}, counted ${r.onHandUnits} → ${unaccountedUnits} units unaccounted`
    );
  }
  const updated = {
    ...row,
    status,
    expectedUnits: r.expectedUnits,
    soldUnits: r.soldUnits,
    quarantinedUnits: r.quarantinedUnits,
    lostInTransitUnits: r.lostInTransitUnits,
    unaccountedUnits,
  };
  ctx.db.affectedLocations.id.update(updated);
  return updated;
}

/** Keeps open recalls' numbers live after a stock change at a location. */
export function refreshAffectedLocations(ctx: Ctx, locationId: string) {
  for (const recall of ctx.db.recalls.iter()) {
    if (recall.status === 'CLOSED') continue;
    const row = findAffectedLocation(ctx, recall.recallId, locationId);
    if (row) reconcileAffectedLocation(ctx, row, 'system');
  }
}

// ---------- Reducers ----------

export const reportRecallSignal = spacetimedb.reducer(
  { rootLotId: t.string(), reason: t.string() },
  (ctx, { rootLotId, reason }) => {
    const org = requireRole(ctx, 'MANUFACTURER');
    if (!ctx.db.lots.lotId.find(rootLotId)) fail('NOT_FOUND', `Lot ${rootLotId} not found`);
    if (!reason.trim()) fail('INVALID_ARGUMENT', 'reason is required');
    const open = [...ctx.db.recalls.iter()].find(r => r.rootLotId === rootLotId && r.status !== 'CLOSED');
    if (open) fail('INVALID_STATE', `${open.recallId} is already open for ${rootLotId}`);

    const cfg = ctx.db.config.id.find(0)!;
    const recallId = `REC-${String(cfg.nextRecallNo).padStart(3, '0')}`;
    ctx.db.config.id.update({ ...cfg, nextRecallNo: cfg.nextRecallNo + 1 });
    ctx.db.recalls.insert({
      recallId,
      rootLotId,
      reason,
      status: 'SIGNAL',
      createdBy: org.id,
      createdAt: ctx.timestamp,
    });
    audit(ctx, recallId, org.id, 'report_recall_signal', `Signal for ${rootLotId}: ${reason}`);
  }
);

export const authorizeRecall = spacetimedb.reducer({ recallId: t.string() }, (ctx, { recallId }) => {
  const org = requireRole(ctx, 'MANUFACTURER');
  const recall = requireRecall(ctx, recallId);
  requireStatus(recall, 'SIGNAL');
  ctx.db.recalls.recallId.update({ ...recall, status: 'AUTHORIZED' });
  audit(ctx, recallId, org.id, 'authorize_recall', `${recallId} authorized by ${org.id}`);
});

/**
 * BFS downstream over lot_edges, then over shipments (trace.ts), and reconciles every
 * location that received an affected lot (reconcile.ts). Pass-through locations
 * (nothing on hand, everything explained, e.g. warehouses that shipped it all onward)
 * are logged but get no containment task.
 */
export const traceRecall = spacetimedb.reducer({ recallId: t.string() }, (ctx, { recallId }) => {
  const org = requireRole(ctx, 'MANUFACTURER');
  const recall = requireRecall(ctx, recallId);
  requireStatus(recall, 'AUTHORIZED');

  const locations = contractLocations(ctx);
  let trace;
  try {
    trace = traceDownstream({
      rootLotId: recall.rootLotId,
      lots: contractLots(ctx),
      lotEdges: contractLotEdges(ctx),
      shipments: contractShipments(ctx),
      shipmentLines: contractShipmentLines(ctx),
      locations,
    });
  } catch (e) {
    fail('NOT_FOUND', String((e as Error).message).replace(/^NOT_FOUND:\s*/, ''));
  }

  for (const lotId of trace.affectedLotIds) ctx.db.affectedLots.insert({ id: 0n, recallId, lotId });

  const passThrough: string[] = [];
  const affected: string[] = [];
  for (const locationId of [...trace.affectedLocationIds].sort()) {
    const r = reconcile(ctx, locationId, trace.affectedLotIds);
    const isStore = locations.find(l => l.id === locationId)?.type === 'STORE';
    if (!isStore && r.onHandUnits === 0 && r.unaccountedUnits === 0) {
      passThrough.push(locationId);
      continue;
    }
    affected.push(locationId);
    const row = ctx.db.affectedLocations.insert({
      id: 0n,
      recallId,
      locationId,
      status: 'AWAITING_ACKNOWLEDGMENT',
      expectedUnits: 0,
      soldUnits: 0,
      quarantinedUnits: 0,
      unaccountedUnits: 0,
      lostInTransitUnits: 0,
      dispositionNote: undefined,
    });
    reconcileAffectedLocation(ctx, row, 'system');
  }

  ctx.db.recalls.recallId.update({ ...recall, status: 'TRACED' });
  const lots = trace.affectedLotIds.join(', ') || 'none';
  const via = passThrough.length ? `; pass-through (fully shipped onward): ${passThrough.join(', ')}` : '';
  audit(
    ctx,
    recallId,
    org.id,
    'trace_recall',
    `${recall.rootLotId} → lots ${lots}; ${affected.length} affected locations: ${affected.join(', ')}${via}`
  );
});

/**
 * One task per affected location. CONNECTED orgs get a lease immediately (their agent
 * is expected to act), so a dead agent times out even if it never claims.
 */
export const assignContainmentTasks = spacetimedb.reducer({ recallId: t.string() }, (ctx, { recallId }) => {
  const org = requireRole(ctx, 'MANUFACTURER');
  const recall = requireRecall(ctx, recallId);
  requireStatus(recall, 'TRACED');

  const lotIds = affectedLotIds(ctx, recallId);
  const cfg = ctx.db.config.id.find(0)!;
  let next = cfg.nextTaskNo;
  const assigned: string[] = [];
  // Sorted so task ids are stable across reseeds (table iteration order is not): T-1 is Store A.
  const rows = [...ctx.db.affectedLocations.recallId.filter(recallId)].sort((a, b) =>
    a.locationId.localeCompare(b.locationId)
  );
  for (const a of rows) {
    const location = ctx.db.locations.id.find(a.locationId)!;
    const owner = ctx.db.organizations.id.find(location.orgId)!;
    const connected = owner.integrationLevel === 'CONNECTED';
    const taskId = `T-${next++}`;
    ctx.db.containmentTasks.insert({
      taskId,
      recallId,
      locationId: a.locationId,
      lotIds: lotIds.filter(lotId => [...ctx.db.inventoryBalances.byLotLocation.filter([lotId, a.locationId])].length > 0),
      state: 'PENDING',
      attempts: connected ? 1 : 0,
      leaseExpiresAt: connected ? plusMs(ctx.timestamp, TASK_LEASE_MS) : undefined,
      dueAt: plusMs(ctx.timestamp, TASK_DUE_MS),
    });
    assigned.push(`${taskId} → ${a.locationId} (${owner.integrationLevel})`);
  }
  ctx.db.config.id.update({ ...cfg, nextTaskNo: next });
  ctx.db.recalls.recallId.update({ ...recall, status: 'CONTAINING' });
  audit(ctx, recallId, org.id, 'assign_containment_tasks', `${assigned.length} tasks: ${assigned.join('; ')}`);
});

export const recordDiscrepancy = spacetimedb.reducer(
  { recallId: t.string(), locationId: t.string(), unaccountedUnits: t.u32(), detail: t.string() },
  (ctx, { recallId, locationId, unaccountedUnits, detail }) => {
    const org = requireRole(ctx, 'MANUFACTURER');
    const recall = requireRecall(ctx, recallId);
    if (recall.status === 'CLOSED') fail('INVALID_STATE', `${recallId} is CLOSED`);
    const row = findAffectedLocation(ctx, recallId, locationId);
    if (!row) fail('NOT_FOUND', `${locationId} is not affected by ${recallId}`);
    ctx.db.affectedLocations.id.update({ ...row, status: 'RECONCILIATION_EXCEPTION', unaccountedUnits });
    audit(ctx, recallId, org.id, 'record_discrepancy', `${locationId}: ${unaccountedUnits} units unaccounted. ${detail}`);
  }
);

export const setDisposition = spacetimedb.reducer(
  { recallId: t.string(), locationId: t.string(), note: t.string() },
  (ctx, { recallId, locationId, note }) => {
    const org = requireRole(ctx, 'MANUFACTURER', 'REGULATOR');
    const recall = requireRecall(ctx, recallId);
    if (recall.status === 'CLOSED') fail('INVALID_STATE', `${recallId} is CLOSED`);
    if (!note.trim()) fail('INVALID_ARGUMENT', 'note is required');
    const row = findAffectedLocation(ctx, recallId, locationId);
    if (!row) fail('NOT_FOUND', `${locationId} is not affected by ${recallId}`);
    ctx.db.affectedLocations.id.update({ ...row, dispositionNote: note });
    audit(ctx, recallId, org.id, 'set_disposition', `${locationId} (${row.status}): ${note}`);
  }
);

/** Only when every affected location is VERIFIED_CONTAINED or has a disposition note. */
export const closeRecall = spacetimedb.reducer(
  { recallId: t.string(), note: t.string() },
  (ctx, { recallId, note }) => {
    const org = requireRole(ctx, 'MANUFACTURER');
    const recall = requireRecall(ctx, recallId);
    if (recall.status === 'CLOSED') fail('INVALID_STATE', `${recallId} is already CLOSED`);
    const open = [...ctx.db.affectedLocations.recallId.filter(recallId)].filter(
      a => a.status !== 'VERIFIED_CONTAINED' && !a.dispositionNote
    );
    if (open.length) {
      fail(
        'CANNOT_CLOSE',
        `Unverified without disposition: ${open.map(a => `${a.locationId} (${a.status})`).join(', ')}`
      );
    }
    ctx.db.recalls.recallId.update({ ...recall, status: 'CLOSED' });
    audit(ctx, recallId, org.id, 'close_recall', note || `${recallId} closed`);
  }
);
