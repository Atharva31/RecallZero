// All RecallZero tables (PLAN.md section 5). Row shapes follow shared/contracts/tables.ts.
// Enum-valued columns are strings validated in reducers (see the *_TYPES / *_STATUSES lists there).
// Link tables use a surrogate autoInc `id` plus indexes on their natural keys.

import { schema, table, t } from 'spacetimedb/server';

const organizations = table(
  { name: 'organizations', public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    type: t.string(), // OrgType
    identity: t.option(t.identity()), // bound by claim_org_identity
    integrationLevel: t.string(), // IntegrationLevel
  }
);

const locations = table(
  { name: 'locations', public: true },
  {
    id: t.string().primaryKey(),
    orgId: t.string().index('btree'),
    name: t.string(),
    type: t.string(), // LocationType
    x: t.f64(),
    y: t.f64(),
  }
);

const products = table(
  { name: 'products', public: true },
  {
    sku: t.string().primaryKey(),
    gtin: t.string(),
    name: t.string(),
  }
);

const lots = table(
  { name: 'lots', public: true },
  {
    lotId: t.string().primaryKey(),
    sku: t.option(t.string()), // none for ingredients
    kind: t.string(), // LotKind
    producedAt: t.timestamp(),
    quantity: t.f64(),
  }
);

const lotEdges = table(
  { name: 'lot_edges', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    parentLotId: t.string().index('btree'),
    childLotId: t.string().index('btree'),
    quantityUsed: t.f64(),
  }
);

const shipments = table(
  { name: 'shipments', public: true },
  {
    shipmentId: t.string().primaryKey(),
    fromLocation: t.string().index('btree'),
    toLocation: t.string().index('btree'),
    status: t.string(), // ShipmentStatus
  }
);

const shipmentLines = table(
  { name: 'shipment_lines', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    shipmentId: t.string().index('btree'),
    lotId: t.string().index('btree'),
    qtyDispatched: t.u32(),
    qtyReceived: t.u32(),
    qtyDamaged: t.u32(),
  }
);

const inventoryEvents = table(
  {
    name: 'inventory_events',
    public: true,
    indexes: [{ accessor: 'byLotLocation', algorithm: 'btree', columns: ['lotId', 'locationId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lotId: t.string(),
    locationId: t.string(),
    type: t.string(), // InventoryEventType
    qty: t.i32(), // ADJUSTED may be negative
    at: t.timestamp(),
    actor: t.string(), // org id
  }
);

const inventoryBalances = table(
  {
    name: 'inventory_balances',
    public: true,
    indexes: [{ accessor: 'byLotLocation', algorithm: 'btree', columns: ['lotId', 'locationId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lotId: t.string(),
    locationId: t.string(),
    available: t.u32(),
    quarantined: t.u32(),
    sold: t.u32(),
    damaged: t.u32(),
  }
);

const recalls = table(
  { name: 'recalls', public: true },
  {
    recallId: t.string().primaryKey(),
    rootLotId: t.string(),
    reason: t.string(),
    status: t.string(), // RecallStatus
    createdBy: t.string(), // org id
    createdAt: t.timestamp(),
  }
);

const affectedLots = table(
  { name: 'affected_lots', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    recallId: t.string().index('btree'),
    lotId: t.string(),
  }
);

const affectedLocations = table(
  { name: 'affected_locations', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    recallId: t.string().index('btree'),
    locationId: t.string(),
    status: t.string(), // AffectedLocationStatus
    expectedUnits: t.u32(),
    soldUnits: t.u32(),
    quarantinedUnits: t.u32(),
    unaccountedUnits: t.u32(),
    lostInTransitUnits: t.u32(),
    dispositionNote: t.option(t.string()),
  }
);

const containmentTasks = table(
  { name: 'containment_tasks', public: true },
  {
    taskId: t.string().primaryKey(),
    recallId: t.string().index('btree'),
    locationId: t.string().index('btree'),
    lotIds: t.array(t.string()),
    state: t.string(), // TaskState
    attempts: t.u32(),
    leaseExpiresAt: t.option(t.timestamp()),
    dueAt: t.timestamp(),
  }
);

const taskAttempts = table(
  { name: 'task_attempts', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    taskId: t.string().index('btree'),
    attemptNo: t.u32(),
    agent: t.string(),
    result: t.string(), // TaskAttemptResult
    at: t.timestamp(),
  }
);

const auditEvents = table(
  { name: 'audit_events', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    recallId: t.option(t.string()),
    actor: t.string(),
    action: t.string(),
    detail: t.string(),
    at: t.timestamp(),
  }
);

/** Private singleton (id = 0): admin identity and id counters. */
const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    admin: t.identity(),
    nextRecallNo: t.u32(),
    nextTaskNo: t.u32(),
  }
);

/** Private repeating timer that drives check_task_timeouts (TIMEOUT_CHECK_INTERVAL_MS). */
export const timeoutTimer = table(
  { name: 'timeout_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  organizations,
  locations,
  products,
  lots,
  lotEdges,
  shipments,
  shipmentLines,
  inventoryEvents,
  inventoryBalances,
  recalls,
  affectedLots,
  affectedLocations,
  containmentTasks,
  taskAttempts,
  auditEvents,
  config,
  timeoutTimer,
});

export default spacetimedb;
