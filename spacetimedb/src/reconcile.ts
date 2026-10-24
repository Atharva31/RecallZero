// OWNER: Prathamesh. Pure function, no SpacetimeDB imports, unit-tested in tests/.
// Atharva calls it from trace_recall / quarantine_lot to fill affected_locations numbers.

import type { InventoryBalance, InventoryEvent, Shipment, ShipmentLine } from '../../shared/contracts/tables';

export interface ReconcileInput {
  locationId: string;
  lotIds: string[]; // affected lots
  shipments: Shipment[];
  shipmentLines: ShipmentLine[];
  events: InventoryEvent[]; // events at this location
  balances: InventoryBalance[]; // balances at this location (current counted stock)
}

export interface Reconciliation {
  locationId: string;
  expectedUnits: number; // received
  soldUnits: number;
  quarantinedUnits: number;
  onHandUnits: number; // available + quarantined
  shippedOnwardUnits: number; // dispatched from this location (warehouses)
  lostInTransitUnits: number; // dispatched to this location - received
  /** received - sold - damaged - shippedOnward - onHand. Store D: 120 - 85 - 20 = 15. */
  unaccountedUnits: number;
}

/**
 * Sources, per affected lot at this location:
 * - shipment lines: received (qtyReceived, which includes units that arrived damaged),
 *   lost in transit (qtyDispatched - qtyReceived), damaged on arrival (qtyDamaged),
 *   shipped onward (qtyDispatched on shipments leaving this location);
 * - events: SOLD and DAMAGED (in-store) quantities;
 * - balances: counted stock (available + quarantined).
 * ADJUSTED events are not treated as an explanation: shrink stays unaccounted.
 * Rows for other locations or unaffected lots are ignored, so callers may pass full tables.
 */
export function reconcileLocation(input: ReconcileInput): Reconciliation {
  const { locationId, shipments, shipmentLines, events, balances } = input;
  const lots = new Set(input.lotIds);
  const shipmentById = new Map(shipments.map((s) => [s.shipmentId, s]));

  let expectedUnits = 0;
  let lostInTransitUnits = 0;
  let damagedUnits = 0;
  let shippedOnwardUnits = 0;
  for (const line of shipmentLines) {
    if (!lots.has(line.lotId)) continue;
    const s = shipmentById.get(line.shipmentId);
    if (!s) continue;
    if (s.toLocation === locationId) {
      expectedUnits += line.qtyReceived;
      lostInTransitUnits += Math.max(0, line.qtyDispatched - line.qtyReceived);
      damagedUnits += line.qtyDamaged;
    }
    if (s.fromLocation === locationId) {
      shippedOnwardUnits += line.qtyDispatched;
    }
  }

  let soldUnits = 0;
  for (const e of events) {
    if (e.locationId !== locationId || !lots.has(e.lotId)) continue;
    if (e.type === 'SOLD') soldUnits += e.qty;
    else if (e.type === 'DAMAGED') damagedUnits += e.qty;
  }

  let quarantinedUnits = 0;
  let onHandUnits = 0;
  for (const b of balances) {
    if (b.locationId !== locationId || !lots.has(b.lotId)) continue;
    quarantinedUnits += b.quarantined;
    onHandUnits += b.available + b.quarantined;
  }

  // Never negative: a surplus is not "unaccounted" stock.
  const unaccountedUnits = Math.max(
    0,
    expectedUnits - soldUnits - damagedUnits - shippedOnwardUnits - onHandUnits,
  );

  return {
    locationId,
    expectedUnits,
    soldUnits,
    quarantinedUnits,
    onHandUnits,
    shippedOnwardUnits,
    lostInTransitUnits,
    unaccountedUnits,
  };
}
