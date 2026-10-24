// RecallZero: agent gateway HTTP contract (PLAN.md section 9).
// FROZEN CONTRACT: only Atharva edits this file, announced in team chat first.
//
// - Base URL: GATEWAY_URL (default http://localhost:4000).
// - JSON in and out, camelCase fields (same as tables.ts).
// - Caller selection: every request sends header `X-Org-Id: <org id>`. The gateway
//   holds one stored SpacetimeDB token per org and calls the reducer as that
//   identity. Coordinator uses ORG-ACME (manufacturer compliance identity);
//   retailer agents use ORG-STORE-A / ORG-STORE-B. Local demo only, no auth.
// - Every response has `ok`. Failures use HTTP 4xx/5xx and the ErrorBody shape,
//   with `code` taken from the reducer error (see reducers.ts ERROR_CODES).

import type { ErrorCode } from './reducers';
import type {
  AffectedLocation,
  AffectedLocationStatus,
  AuditEvent,
  ContainmentTask,
  IntegrationLevel,
  InventoryBalance,
  Lot,
  Recall,
} from './tables';

export const ORG_HEADER = 'X-Org-Id';

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode | 'UNKNOWN' | 'BAD_REQUEST'; message: string };
}
export type Ok<T> = { ok: true } & T;
export type ApiResponse<T> = Ok<T> | ErrorBody;

// ---------- Shared read models ----------

export interface Coverage {
  affectedLocations: number;
  verifiedLocations: number;
  awaitingLocations: number;
  exceptionLocations: number; // INVENTORY_UNKNOWN + ACTION_FAILED + RECONCILIATION_EXCEPTION + PARTIALLY_CONTAINED
  /** verifiedLocations / affectedLocations, 0..1 */
  locationCoverage: number;
  quarantinedUnits: number;
  knownUnsoldUnits: number;
  /** quarantinedUnits / knownUnsoldUnits, 0..1 */
  unitCoverage: number;
}

export interface TaskWithTarget extends ContainmentTask {
  orgId: string;
  integrationLevel: IntegrationLevel; // CONNECTED -> coordinator messages the retailer agent
}

export interface RecallStatus {
  recall: Recall;
  affectedLots: string[];
  affectedLocations: AffectedLocation[];
  tasks: TaskWithTarget[];
  coverage: Coverage;
  /** True when every location is VERIFIED_CONTAINED or in a terminal non-contained state (escalated/exception/failed). */
  settled: boolean;
}

/** Committed facts only. The coordinator drafts report prose from this, nothing else. */
export interface ReportFacts {
  recallId: string;
  rootLotId: string;
  reason: string;
  affectedLots: string[];
  coverage: Coverage;
  verified: { locationId: string; quarantinedUnits: number }[];
  soldBeforeRecall: { locationId: string; units: number }[];
  lostInTransit: { locationId: string; units: number }[];
  unaccounted: { locationId: string; units: number }[];
  unknown: { locationId: string; status: AffectedLocationStatus }[];
  escalated: { locationId: string; taskId: string; attempts: number }[];
  generatedAt: string;
}

// ---------- Endpoints ----------

export const ENDPOINTS = {
  health: { method: 'GET', path: '/health' },
  getLot: { method: 'GET', path: '/lots/:lotId' },
  reportRecallSignal: { method: 'POST', path: '/recalls' },
  authorizeRecall: { method: 'POST', path: '/recalls/:recallId/authorize' },
  traceRecall: { method: 'POST', path: '/recalls/:recallId/trace' },
  assignContainmentTasks: { method: 'POST', path: '/recalls/:recallId/assign' },
  getRecallStatus: { method: 'GET', path: '/recalls/:recallId/status' },
  getReportFacts: { method: 'GET', path: '/recalls/:recallId/report' },
  closeRecall: { method: 'POST', path: '/recalls/:recallId/close' },
  getTask: { method: 'GET', path: '/tasks/:taskId' },
  claimTask: { method: 'POST', path: '/tasks/:taskId/claim' },
  quarantineLot: { method: 'POST', path: '/tasks/:taskId/quarantine' },
  getInventory: { method: 'GET', path: '/locations/:locationId/inventory' },
  recordSale: { method: 'POST', path: '/sales' },
  getAudit: { method: 'GET', path: '/audit' }, // ?recallId=REC-001
} as const;

// Request bodies (GET and path-only POSTs have none) and response payloads.

export type HealthResponse = Ok<{ spacetimedb: 'connected' | 'mock' | 'disconnected'; orgs: string[] }>;

export type GetLotResponse = Ok<{ lot: Lot }>; // 404 NOT_FOUND if missing

export interface ReportRecallSignalRequest {
  rootLotId: string;
  reason: string;
}
export type ReportRecallSignalResponse = Ok<{ recall: Recall }>;

export type AuthorizeRecallResponse = Ok<{ recall: Recall }>;

export type TraceRecallResponse = Ok<{ recall: Recall; affectedLots: string[]; affectedLocations: AffectedLocation[] }>;

export type AssignContainmentTasksResponse = Ok<{ recall: Recall; tasks: TaskWithTarget[] }>;

export type GetRecallStatusResponse = Ok<RecallStatus>;

export type GetReportFactsResponse = Ok<{ facts: ReportFacts }>;

export interface CloseRecallRequest {
  note: string;
}
export type CloseRecallResponse = Ok<{ recall: Recall }>;

export type GetTaskResponse = Ok<{ task: TaskWithTarget }>;

export type ClaimTaskResponse = Ok<{ task: TaskWithTarget }>;

/** Values are read back from the database after the reducer commits. */
export type QuarantineLotResponse = Ok<{
  task: TaskWithTarget;
  affectedLocation: AffectedLocation;
  quarantinedUnits: number;
}>;

export type GetInventoryResponse = Ok<{ locationId: string; balances: InventoryBalance[] }>;

export interface RecordSaleRequest {
  locationId: string;
  lotId: string;
  qty: number;
}
/** On a quarantined lot: 409 with code LOT_QUARANTINED and the POS-ready message. */
export type RecordSaleResponse = Ok<{ balance: InventoryBalance }>;

export type GetAuditResponse = Ok<{ events: AuditEvent[] }>;
