// Converts generated SpacetimeDB binding rows into the contract shapes in
// contracts/tables.ts (bigint ids -> number, Timestamp -> ISO string,
// Identity -> hex, undefined options -> null, string enums -> enum types).
// Structurally typed so the gateway and the web app can each pass rows from
// their own generated bindings.

import type {
  AffectedLocation,
  AffectedLot,
  AuditEvent,
  ContainmentTask,
  InventoryBalance,
  InventoryEvent,
  Location,
  Lot,
  LotEdge,
  Organization,
  Product,
  Recall,
  Shipment,
  ShipmentLine,
} from './contracts/tables';

interface Ts {
  toISOString(): string;
}
interface Ident {
  toHexString(): string;
}

/** Row as stored: contract fields with enums widened to string, plus overrides. */
type Wire<T, O = {}> = { [K in Exclude<keyof T, keyof O>]: T[K] extends string ? string : T[K] } & O;

const iso = (ts: Ts) => ts.toISOString();

export const toOrganization = (r: Wire<Organization, { identity?: Ident }>): Organization => ({
  id: r.id,
  name: r.name,
  type: r.type as Organization['type'],
  identity: r.identity ? r.identity.toHexString() : null,
  integrationLevel: r.integrationLevel as Organization['integrationLevel'],
});

export const toLocation = (r: Wire<Location>): Location => ({
  id: r.id,
  orgId: r.orgId,
  name: r.name,
  type: r.type as Location['type'],
  x: r.x,
  y: r.y,
});

export const toProduct = (r: Wire<Product>): Product => ({ sku: r.sku, gtin: r.gtin, name: r.name });

export const toLot = (r: Wire<Lot, { sku?: string; producedAt: Ts }>): Lot => ({
  lotId: r.lotId,
  sku: r.sku ?? null,
  kind: r.kind as Lot['kind'],
  producedAt: iso(r.producedAt),
  quantity: r.quantity,
});

export const toLotEdge = (r: Wire<LotEdge>): LotEdge => ({
  parentLotId: r.parentLotId,
  childLotId: r.childLotId,
  quantityUsed: r.quantityUsed,
});

export const toShipment = (r: Wire<Shipment>): Shipment => ({
  shipmentId: r.shipmentId,
  fromLocation: r.fromLocation,
  toLocation: r.toLocation,
  status: r.status as Shipment['status'],
});

export const toShipmentLine = (r: Wire<ShipmentLine>): ShipmentLine => ({
  shipmentId: r.shipmentId,
  lotId: r.lotId,
  qtyDispatched: r.qtyDispatched,
  qtyReceived: r.qtyReceived,
  qtyDamaged: r.qtyDamaged,
});

export const toInventoryEvent = (r: Wire<InventoryEvent, { id: bigint; at: Ts }>): InventoryEvent => ({
  id: Number(r.id),
  lotId: r.lotId,
  locationId: r.locationId,
  type: r.type as InventoryEvent['type'],
  qty: r.qty,
  at: iso(r.at),
  actor: r.actor,
});

export const toInventoryBalance = (r: Wire<InventoryBalance>): InventoryBalance => ({
  lotId: r.lotId,
  locationId: r.locationId,
  available: r.available,
  quarantined: r.quarantined,
  sold: r.sold,
  damaged: r.damaged,
});

export const toRecall = (r: Wire<Recall, { createdAt: Ts }>): Recall => ({
  recallId: r.recallId,
  rootLotId: r.rootLotId,
  reason: r.reason,
  status: r.status as Recall['status'],
  createdBy: r.createdBy,
  createdAt: iso(r.createdAt),
});

export const toAffectedLot = (r: Wire<AffectedLot>): AffectedLot => ({ recallId: r.recallId, lotId: r.lotId });

export const toAffectedLocation = (r: Wire<AffectedLocation, { dispositionNote?: string }>): AffectedLocation => ({
  recallId: r.recallId,
  locationId: r.locationId,
  status: r.status as AffectedLocation['status'],
  expectedUnits: r.expectedUnits,
  soldUnits: r.soldUnits,
  quarantinedUnits: r.quarantinedUnits,
  unaccountedUnits: r.unaccountedUnits,
  lostInTransitUnits: r.lostInTransitUnits,
  dispositionNote: r.dispositionNote ?? null,
});

export const toContainmentTask = (
  r: Wire<ContainmentTask, { lotIds: readonly string[] | string[]; leaseExpiresAt?: Ts; dueAt: Ts }>
): ContainmentTask => ({
  taskId: r.taskId,
  recallId: r.recallId,
  locationId: r.locationId,
  lotIds: [...r.lotIds],
  state: r.state as ContainmentTask['state'],
  attempts: r.attempts,
  leaseExpiresAt: r.leaseExpiresAt ? iso(r.leaseExpiresAt) : null,
  dueAt: iso(r.dueAt),
});

export const toAuditEvent = (r: Wire<AuditEvent, { id: bigint; recallId?: string; at: Ts }>): AuditEvent => ({
  id: Number(r.id),
  recallId: r.recallId ?? null,
  actor: r.actor,
  action: r.action,
  detail: r.detail,
  at: iso(r.at),
});
