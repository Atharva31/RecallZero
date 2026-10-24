// OWNER: Prathamesh. Pure function, no SpacetimeDB imports, unit-tested in tests/.
// Atharva calls it from trace_recall with rows converted to the contract shapes.

import type { Location, Lot, LotEdge, Shipment, ShipmentLine } from '../../shared/contracts/tables';

export interface TraceInput {
  rootLotId: string;
  lots: Lot[];
  lotEdges: LotEdge[];
  shipments: Shipment[];
  shipmentLines: ShipmentLine[];
  locations: Location[];
}

export interface TraceResult {
  /** Every lot downstream of rootLotId (excluding the root itself), BFS over lotEdges. */
  affectedLotIds: string[];
  /** Every location that received any affected lot, BFS over shipments. */
  affectedLocationIds: string[];
}

/** O(V+E). PEANUT-009 -> BAR-100, BAR-101; must NOT include BAR-102 or STORE-F. */
export function traceDownstream(_input: TraceInput): TraceResult {
  throw new Error('trace.ts: not implemented yet (Prathamesh)');
}
