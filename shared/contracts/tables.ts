// RecallZero: table row types and status enums (PLAN.md sections 5 and 7).
// FROZEN CONTRACT: only Atharva edits this file, announced in team chat first.
//
// Conventions
// - Field names are camelCase. SpacetimeDB stores them snake_case and the
//   generated client bindings expose them camelCase, so these match the bindings.
// - Enums are stored as strings in SpacetimeDB and validated in reducers.
// - Timestamps cross JSON boundaries (fixtures, gateway) as ISO-8601 strings.
// - Ids are natural string keys ("STORE-A", "BAR-100") except for append-only
//   logs (inventoryEvents, auditEvents), which use auto-increment numbers.
// - These are the app-facing (JSON) shapes used by fixtures, the gateway and
//   web/lib/data.ts. Generated SpacetimeDB bindings differ slightly: u64 ids are
//   bigint, timestamps are Timestamp objects, options are `undefined`, and
//   link tables carry a surrogate `id`. Convert at the data-layer boundary.

// ---------- Enums ----------

export const ORG_TYPES = ['MANUFACTURER', 'DISTRIBUTOR', 'RETAILER', 'REGULATOR'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const INTEGRATION_LEVELS = ['MANUAL', 'CONNECTED'] as const;
export type IntegrationLevel = (typeof INTEGRATION_LEVELS)[number];

export const LOCATION_TYPES = ['FACTORY', 'WAREHOUSE', 'STORE'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOT_KINDS = ['INGREDIENT', 'FINISHED'] as const;
export type LotKind = (typeof LOT_KINDS)[number];

export const SHIPMENT_STATUSES = ['DISPATCHED', 'RECEIVED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const INVENTORY_EVENT_TYPES = ['RECEIVED', 'SOLD', 'DAMAGED', 'QUARANTINED', 'ADJUSTED'] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

export const RECALL_STATUSES = ['SIGNAL', 'AUTHORIZED', 'TRACED', 'CONTAINING', 'CLOSED'] as const;
export type RecallStatus = (typeof RECALL_STATUSES)[number];

/** Only VERIFIED_CONTAINED counts as contained. */
export const AFFECTED_LOCATION_STATUSES = [
  'AWAITING_ACKNOWLEDGMENT',
  'VERIFIED_CONTAINED',
  'PARTIALLY_CONTAINED',
  'INVENTORY_UNKNOWN',
  'ACTION_FAILED',
  'RECONCILIATION_EXCEPTION',
] as const;
export type AffectedLocationStatus = (typeof AFFECTED_LOCATION_STATUSES)[number];

/**
 * PENDING -> CLAIMED -> IN_PROGRESS -> VERIFIED
 * IN_PROGRESS -> TIMED_OUT -> RETRY_PENDING -> (retry) | ESCALATED
 */
export const TASK_STATES = [
  'PENDING',
  'CLAIMED',
  'IN_PROGRESS',
  'VERIFIED',
  'TIMED_OUT',
  'RETRY_PENDING',
  'ESCALATED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ATTEMPT_RESULTS = ['CLAIMED', 'QUARANTINED', 'TIMED_OUT', 'FAILED', 'ESCALATED'] as const;
export type TaskAttemptResult = (typeof TASK_ATTEMPT_RESULTS)[number];

/** Demo-mode timing (configurable). */
export const TASK_LEASE_MS = 20_000;
export const TASK_MAX_RETRIES = 2;
export const TIMEOUT_CHECK_INTERVAL_MS = 5_000;

// ---------- Tables ----------

export type IsoTimestamp = string;
/** Hex-encoded SpacetimeDB Identity. */
export type IdentityHex = string;

export interface Organization {
  id: string; // "ORG-STORE-A"
  name: string;
  type: OrgType;
  /** Bound at runtime by the gateway (see reducers.ts claimOrgIdentity). Null until bound. */
  identity: IdentityHex | null;
  integrationLevel: IntegrationLevel;
}

export interface Location {
  id: string; // "STORE-A"
  orgId: string;
  name: string;
  type: LocationType;
  x: number; // graph layout
  y: number;
}

export interface Product {
  sku: string; // "BAR-100"
  gtin: string;
  name: string;
}

/** Finished-good lots use lotId == sku in the demo fixtures (one lot per product). */
export interface Lot {
  lotId: string;
  sku: string | null; // null for ingredients
  kind: LotKind;
  producedAt: IsoTimestamp;
  quantity: number; // kg for ingredients, units for finished goods
}

export interface LotEdge {
  parentLotId: string; // ingredient
  childLotId: string; // product made from it
  quantityUsed: number;
}

export interface Shipment {
  shipmentId: string;
  fromLocation: string;
  toLocation: string;
  status: ShipmentStatus;
}

export interface ShipmentLine {
  shipmentId: string;
  lotId: string;
  qtyDispatched: number;
  qtyReceived: number;
  qtyDamaged: number;
}

export interface InventoryEvent {
  id: number;
  lotId: string;
  locationId: string;
  type: InventoryEventType;
  qty: number;
  at: IsoTimestamp;
  actor: string; // org id
}

/** Materialized current state. Key: (lotId, locationId). */
export interface InventoryBalance {
  lotId: string;
  locationId: string;
  available: number;
  quarantined: number;
  sold: number;
  damaged: number;
}

export interface Recall {
  recallId: string; // "REC-001"
  rootLotId: string;
  reason: string;
  status: RecallStatus;
  createdBy: string; // org id
  createdAt: IsoTimestamp;
}

export interface AffectedLot {
  recallId: string;
  lotId: string;
}

export interface AffectedLocation {
  recallId: string;
  locationId: string;
  status: AffectedLocationStatus;
  /** Units received at this location for affected lots. */
  expectedUnits: number;
  soldUnits: number;
  quarantinedUnits: number;
  /** Units that cannot be explained by sales, quarantine, damage or onward shipment. */
  unaccountedUnits: number;
  /** Units lost between dispatch and receipt (qtyDispatched - qtyReceived). */
  lostInTransitUnits: number;
  /** Required by closeRecall when the location is not VERIFIED_CONTAINED. */
  dispositionNote: string | null;
}

export interface ContainmentTask {
  taskId: string; // "T-7"
  recallId: string;
  locationId: string;
  lotIds: string[];
  state: TaskState;
  attempts: number;
  leaseExpiresAt: IsoTimestamp | null;
  dueAt: IsoTimestamp;
}

export interface TaskAttempt {
  taskId: string;
  attemptNo: number;
  agent: string; // org id or agent address
  result: TaskAttemptResult;
  at: IsoTimestamp;
}

export interface AuditEvent {
  id: number;
  recallId: string | null;
  actor: string; // org id
  action: string; // reducer name, e.g. "quarantine_lot"
  detail: string; // human-readable
  at: IsoTimestamp;
}
