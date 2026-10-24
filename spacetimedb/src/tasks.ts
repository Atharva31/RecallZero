// Containment tasks: PENDING -> CLAIMED -> VERIFIED, or lease expiry ->
// TIMED_OUT -> RETRY_PENDING -> ... -> ESCALATED (location becomes INVENTORY_UNKNOWN).

import { t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

import spacetimedb, { timeoutTimer } from './schema';
import { audit } from './audit';
import { fail, plusMs, type Ctx } from './common';
import { findBalance, recordEvent } from './inventory';
import { requireLocationOwner } from './permissions';
import { affectedLotIds, findAffectedLocation, reconcileAffectedLocation, requireRecall } from './recalls';
import {
  TASK_LEASE_MS,
  TASK_MAX_RETRIES,
  TIMEOUT_CHECK_INTERVAL_MS,
  type TaskAttemptResult,
} from '../../shared/contracts/tables';

function requireTask(ctx: Ctx, taskId: string) {
  const task = ctx.db.containmentTasks.taskId.find(taskId);
  if (!task) fail('NOT_FOUND', `Task ${taskId} not found`);
  return task;
}

function recordAttempt(ctx: Ctx, taskId: string, attemptNo: number, agent: string, result: TaskAttemptResult) {
  ctx.db.taskAttempts.insert({ id: 0n, taskId, attemptNo, agent, result, at: ctx.timestamp });
}

/** Called from init and seed_fixtures so the timer survives resets. */
export function ensureTimeoutTimer(ctx: Ctx) {
  if (ctx.db.timeoutTimer.count() > 0n) return;
  ctx.db.timeoutTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(TIMEOUT_CHECK_INTERVAL_MS) * 1000n),
  });
}

/** Sets a lease. Only the org that owns the task's location may claim. */
export const claimTask = spacetimedb.reducer({ taskId: t.string() }, (ctx, { taskId }) => {
  const task = requireTask(ctx, taskId);
  const { org } = requireLocationOwner(ctx, task.locationId, 'RETAILER', 'DISTRIBUTOR');
  if (requireRecall(ctx, task.recallId).status !== 'CONTAINING') {
    fail('INVALID_STATE', `${task.recallId} is not CONTAINING`);
  }
  if (task.state === 'VERIFIED' || task.state === 'ESCALATED') fail('INVALID_STATE', `${taskId} is ${task.state}`);
  if (task.state === 'CLAIMED' || task.state === 'IN_PROGRESS') fail('LEASE_HELD', `${taskId} is already claimed`);

  const attempts = Math.max(task.attempts, 1); // MANUAL tasks start without a lease window
  ctx.db.containmentTasks.taskId.update({
    ...task,
    state: 'CLAIMED',
    attempts,
    leaseExpiresAt: plusMs(ctx.timestamp, TASK_LEASE_MS),
  });
  recordAttempt(ctx, taskId, attempts, org.id, 'CLAIMED');
  audit(ctx, task.recallId, org.id, 'claim_task', `${taskId} claimed by ${org.id} (attempt ${attempts})`);
});

/**
 * Idempotent. Moves all available stock of the task's lots to quarantined, writes
 * QUARANTINED events, and marks the location VERIFIED_CONTAINED unless the numbers
 * don't reconcile (then it stays / becomes RECONCILIATION_EXCEPTION). Reducers can't
 * return data, so callers read the committed result back from affected_locations.
 * A late confirmation after escalation is accepted: committed stock is the truth.
 */
export const quarantineLot = spacetimedb.reducer({ taskId: t.string() }, (ctx, { taskId }) => {
  const task = requireTask(ctx, taskId);
  const { org } = requireLocationOwner(ctx, task.locationId, 'RETAILER', 'DISTRIBUTOR');
  if (task.state === 'VERIFIED') return;

  const recall = requireRecall(ctx, task.recallId);
  if (recall.status !== 'CONTAINING') fail('INVALID_STATE', `${recall.recallId} is ${recall.status}, expected CONTAINING`);
  const affected = new Set(affectedLotIds(ctx, recall.recallId));
  const notAffected = task.lotIds.filter(lotId => !affected.has(lotId));
  if (notAffected.length) fail('INVALID_ARGUMENT', `${notAffected.join(', ')} not affected by ${recall.recallId}`);
  const row = findAffectedLocation(ctx, recall.recallId, task.locationId);
  if (!row) fail('NOT_FOUND', `${task.locationId} is not affected by ${recall.recallId}`);

  let moved = 0;
  for (const lotId of task.lotIds) {
    const b = findBalance(ctx, lotId, task.locationId);
    if (!b || b.available === 0) continue;
    moved += b.available;
    ctx.db.inventoryBalances.id.update({ ...b, available: 0, quarantined: b.quarantined + b.available });
    recordEvent(ctx, lotId, task.locationId, 'QUARANTINED', b.available, org.id);
  }

  const wasEscalated = task.state === 'ESCALATED';
  const attempts = Math.max(task.attempts, 1);
  ctx.db.containmentTasks.taskId.update({ ...task, state: 'VERIFIED', attempts, leaseExpiresAt: undefined });
  recordAttempt(ctx, taskId, attempts, org.id, 'QUARANTINED');

  // Unknown / failed locations are now known: re-evaluate from the committed numbers.
  const base =
    row.status === 'INVENTORY_UNKNOWN' || row.status === 'ACTION_FAILED' ? { ...row, status: 'AWAITING_ACKNOWLEDGMENT' } : row;
  const reconciled = reconcileAffectedLocation(ctx, base, org.id);
  const status = reconciled.status === 'RECONCILIATION_EXCEPTION' ? reconciled.status : 'VERIFIED_CONTAINED';
  ctx.db.affectedLocations.id.update({ ...reconciled, status });

  const late = wasEscalated ? ' (late confirmation after escalation)' : '';
  audit(
    ctx,
    recall.recallId,
    org.id,
    'quarantine_lot',
    `${task.locationId}: ${moved} units of ${task.lotIds.join(', ')} quarantined → ${status}${late}`
  );
});

/**
 * Scheduled every TIMEOUT_CHECK_INTERVAL_MS. attempts = lease windows started.
 * Expired lease with attempts <= TASK_MAX_RETRIES -> RETRY_PENDING with a new lease;
 * otherwise ESCALATED and the location becomes INVENTORY_UNKNOWN.
 */
export const checkTaskTimeouts = spacetimedb.reducer(
  { onSchedule: timeoutTimer },
  { timer: timeoutTimer.rowType },
  ctx => {
    if (!ctx.sender.equals(ctx.databaseIdentity)) fail('UNAUTHORIZED', 'check_task_timeouts is scheduled-only');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const task of ctx.db.containmentTasks.iter()) {
      if (task.state === 'VERIFIED' || task.state === 'ESCALATED') continue;
      if (!task.leaseExpiresAt || task.leaseExpiresAt.microsSinceUnixEpoch > now) continue;

      recordAttempt(ctx, task.taskId, task.attempts, 'system', 'TIMED_OUT');
      if (task.attempts > TASK_MAX_RETRIES) {
        ctx.db.containmentTasks.taskId.update({ ...task, state: 'ESCALATED', leaseExpiresAt: undefined });
        recordAttempt(ctx, task.taskId, task.attempts, 'system', 'ESCALATED');
        const row = findAffectedLocation(ctx, task.recallId, task.locationId);
        if (row && row.status !== 'VERIFIED_CONTAINED') {
          ctx.db.affectedLocations.id.update({ ...row, status: 'INVENTORY_UNKNOWN' });
        }
        audit(
          ctx,
          task.recallId,
          'system',
          'check_task_timeouts',
          `${task.taskId} escalated after ${task.attempts} attempts; ${task.locationId} INVENTORY_UNKNOWN`
        );
      } else {
        ctx.db.containmentTasks.taskId.update({
          ...task,
          state: 'RETRY_PENDING',
          attempts: task.attempts + 1,
          leaseExpiresAt: plusMs(ctx.timestamp, TASK_LEASE_MS),
        });
        audit(
          ctx,
          task.recallId,
          'system',
          'check_task_timeouts',
          `${task.taskId} timed out (attempt ${task.attempts} of ${TASK_MAX_RETRIES + 1}); retry pending`
        );
      }
    }
  }
);
