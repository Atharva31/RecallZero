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

export function reconcileLocation(_input: ReconcileInput): Reconciliation {
  throw new Error('reconcile.ts: not implemented yet (Prathamesh)');
}
