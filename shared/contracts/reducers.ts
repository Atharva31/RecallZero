// RecallZero: reducer contract (PLAN.md section 8).
// FROZEN CONTRACT: only Atharva edits this file, announced in team chat first.
//
// Every reducer:
// - identifies the caller by ctx.sender -> organizations.identity (never by an orgId argument),
// - checks the org's role (allowedCallers below),
// - appends an auditEvents row for every state change,
// - fails by throwing SenderError(message). The message starts with an ErrorCode
//   followed by ": " and a human-readable explanation, e.g.
//   "LOT_QUARANTINED: Sale blocked: lot BAR-100 under recall REC-001".
//
// Names: the module exports camelCase (client: conn.reducers.recordSale(...));
// the database name is snake_case (CLI: spacetime call recallzero record_sale ...).

import type { OrgType } from './tables';

export const ERROR_CODES = [
  'UNAUTHORIZED', // caller identity not bound to an org, or wrong role/owner
  'NOT_FOUND', // lot, location, recall or task does not exist
  'INVALID_STATE', // e.g. authorize a recall that is not in SIGNAL
  'LOT_QUARANTINED', // record_sale on a quarantined lot
  'INSUFFICIENT_STOCK', // record_sale qty > available
  'LEASE_HELD', // claim_task while another lease is active
  'RECONCILIATION_FAILED', // quarantine committed but numbers don't reconcile
  'CANNOT_CLOSE', // close_recall with unverified locations lacking a disposition note
  'INVALID_ARGUMENT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Parse "CODE: message" from a reducer error string. */
export function parseReducerError(raw: string): { code: ErrorCode | 'UNKNOWN'; message: string } {
  const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(raw);
  if (m && (ERROR_CODES as readonly string[]).includes(m[1])) {
    return { code: m[1] as ErrorCode, message: m[2] };
  }
  return { code: 'UNKNOWN', message: raw };
}

type Caller = OrgType | 'ADMIN' | 'ANY_BOUND_ORG';

interface ReducerSpec<Args> {
  /** Database (snake_case) name. */
  name: string;
  allowedCallers: readonly Caller[];
  /** Phantom field for typing args; never set at runtime. */
  args?: Args;
}

// ---------- Argument types ----------

export interface PingArgs {}
/** Dev only. Caller must be the admin (database owner). Wipes and reloads fixtures/. */
export interface SeedFixturesArgs {}
/**
 * Dev only. Binds ctx.sender to the org if the org is unbound (or already bound to ctx.sender).
 * The gateway opens one connection per org and calls this once per connection.
 * (Modules cannot build an Identity from a string, so the org's own connection claims it.)
 * seed_fixtures clears all bindings.
 */
export interface ClaimOrgIdentityArgs {
  orgId: string;
}
export interface RecordSaleArgs {
  locationId: string;
  lotId: string;
  qty: number;
}
export interface ReportRecallSignalArgs {
  rootLotId: string;
  reason: string;
}
export interface RecallIdArgs {
  recallId: string;
}
export interface TaskIdArgs {
  taskId: string;
}
export interface RecordDiscrepancyArgs {
  recallId: string;
  locationId: string;
  unaccountedUnits: number;
  detail: string;
}
export interface CloseRecallArgs {
  recallId: string;
  note: string;
}
/** Set a disposition note on an unverified location so the recall can close. */
export interface SetDispositionArgs {
  recallId: string;
  locationId: string;
  note: string;
}

// ---------- Reducers ----------

export const REDUCERS = {
  ping: { name: 'ping', allowedCallers: ['ANY_BOUND_ORG', 'ADMIN'] } as ReducerSpec<PingArgs>,
  seedFixtures: { name: 'seed_fixtures', allowedCallers: ['ADMIN'] } as ReducerSpec<SeedFixturesArgs>,
  claimOrgIdentity: { name: 'claim_org_identity', allowedCallers: ['ANY_BOUND_ORG', 'ADMIN'] } as ReducerSpec<ClaimOrgIdentityArgs>,

  /** Rejects with LOT_QUARANTINED if the lot is quarantined at that location, INSUFFICIENT_STOCK if available < qty. */
  recordSale: { name: 'record_sale', allowedCallers: ['RETAILER'] } as ReducerSpec<RecordSaleArgs>,

  /** Creates a recall in SIGNAL. Recall id is generated (REC-001, REC-002, ...). */
  reportRecallSignal: { name: 'report_recall_signal', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<ReportRecallSignalArgs>,
  /** SIGNAL -> AUTHORIZED. */
  authorizeRecall: { name: 'authorize_recall', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<RecallIdArgs>,
  /** BFS lot_edges downstream then shipment_lines to locations. Writes affectedLots/affectedLocations. AUTHORIZED -> TRACED. */
  traceRecall: { name: 'trace_recall', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<RecallIdArgs>,
  /** One task per affected location. TRACED -> CONTAINING. */
  assignContainmentTasks: { name: 'assign_containment_tasks', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<RecallIdArgs>,

  /** Sets a lease (TASK_LEASE_MS). Only the org that owns the task's location may claim. */
  claimTask: { name: 'claim_task', allowedCallers: ['RETAILER', 'DISTRIBUTOR'] } as ReducerSpec<TaskIdArgs>,
  /**
   * Idempotent. Validates recall authorized, lot affected, caller owns location.
   * Moves available -> quarantined, writes QUARANTINED event, marks location
   * VERIFIED_CONTAINED unless reconciliation fails (-> RECONCILIATION_EXCEPTION).
   * Used by retailer agents and by the manual "Confirm quarantine" button.
   */
  quarantineLot: { name: 'quarantine_lot', allowedCallers: ['RETAILER', 'DISTRIBUTOR'] } as ReducerSpec<TaskIdArgs>,
  /** Opens RECONCILIATION_EXCEPTION on a location. */
  recordDiscrepancy: { name: 'record_discrepancy', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<RecordDiscrepancyArgs>,
  setDisposition: { name: 'set_disposition', allowedCallers: ['MANUFACTURER', 'REGULATOR'] } as ReducerSpec<SetDispositionArgs>,
  /** Allowed only if every affected location is VERIFIED_CONTAINED or has a dispositionNote. -> CLOSED. */
  closeRecall: { name: 'close_recall', allowedCallers: ['MANUFACTURER'] } as ReducerSpec<CloseRecallArgs>,

  // Scheduled, not client-callable:
  // check_task_timeouts runs every TIMEOUT_CHECK_INTERVAL_MS. Expired lease ->
  // TIMED_OUT -> RETRY_PENDING (attempts < TASK_MAX_RETRIES) or ESCALATED;
  // on ESCALATED the location becomes INVENTORY_UNKNOWN.
} as const;

export type ReducerKey = keyof typeof REDUCERS;
