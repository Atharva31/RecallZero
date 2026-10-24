// Loads fixtures/*.json typed as the contract shapes.

import { readFileSync } from 'node:fs';
import type {
  InventoryBalance,
  InventoryEvent,
  Location,
  Lot,
  LotEdge,
  Organization,
  Product,
  Shipment,
  ShipmentLine,
} from '../shared/contracts/tables.ts';

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

export const fixtures = () => ({
  organizations: load<Organization[]>('organizations'),
  locations: load<Location[]>('locations'),
  products: load<Product[]>('products'),
  lots: load<Lot[]>('lots'),
  lotEdges: load<LotEdge[]>('lot_edges'),
  shipments: load<Shipment[]>('shipments'),
  shipmentLines: load<ShipmentLine[]>('shipment_lines'),
  events: load<InventoryEvent[]>('inventory_events'),
  balances: load<InventoryBalance[]>('inventory_balances'),
});
