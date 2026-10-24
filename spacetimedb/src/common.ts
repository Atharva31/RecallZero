// Shared helpers for reducers: context type, errors, time, row -> contract conversions.

import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';

import type spacetimedb from './schema';
import type { ErrorCode } from '../../shared/contracts/reducers';
import type {
  InventoryBalance,
  InventoryEvent,
  InventoryEventType,
  Location,
  Lot,
  LotEdge,
  Shipment,
  ShipmentLine,
} from '../../shared/contracts/tables';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

/** Throws the contract error shape "CODE: message". */
export function fail(code: ErrorCode, message: string): never {
  throw new SenderError(`${code}: ${message}`);
}

export function plusMs(ts: Timestamp, ms: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(ms) * 1000n);
}

export function fromIso(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

const iso = (ts: Timestamp) => ts.toISOString();

// ---------- Row -> contract shapes (for the pure trace / reconcile functions) ----------

export function contractLots(ctx: Ctx): Lot[] {
  return [...ctx.db.lots.iter()].map(l => ({
    lotId: l.lotId,
    sku: l.sku ?? null,
    kind: l.kind as Lot['kind'],
    producedAt: iso(l.producedAt),
    quantity: l.quantity,
  }));
}

export function contractLotEdges(ctx: Ctx): LotEdge[] {
  return [...ctx.db.lotEdges.iter()].map(e => ({
    parentLotId: e.parentLotId,
    childLotId: e.childLotId,
    quantityUsed: e.quantityUsed,
  }));
}

export function contractShipments(ctx: Ctx): Shipment[] {
  return [...ctx.db.shipments.iter()].map(s => ({ ...s, status: s.status as Shipment['status'] }));
}

export function contractShipmentLines(ctx: Ctx): ShipmentLine[] {
  return [...ctx.db.shipmentLines.iter()].map(({ id: _id, ...line }) => line);
}

export function contractLocations(ctx: Ctx): Location[] {
  return [...ctx.db.locations.iter()].map(l => ({ ...l, type: l.type as Location['type'] }));
}

export function contractEventsAt(ctx: Ctx, locationId: string, lotIds: string[]): InventoryEvent[] {
  return lotIds.flatMap(lotId =>
    [...ctx.db.inventoryEvents.byLotLocation.filter([lotId, locationId])].map(e => ({
      id: Number(e.id),
      lotId: e.lotId,
      locationId: e.locationId,
      type: e.type as InventoryEventType,
      qty: e.qty,
      at: iso(e.at),
      actor: e.actor,
    }))
  );
}

export function contractBalancesAt(ctx: Ctx, locationId: string, lotIds: string[]): InventoryBalance[] {
  return lotIds.flatMap(lotId =>
    [...ctx.db.inventoryBalances.byLotLocation.filter([lotId, locationId])].map(({ id: _id, ...b }) => b)
  );
}
