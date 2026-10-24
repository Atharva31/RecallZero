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

/**
 * O(V+E). PEANUT-009 -> BAR-100, BAR-101; must NOT include BAR-102 or STORE-F.
 *
 * - Lots: BFS from the root over parent -> child edges (multi-level, cycle-safe).
 * - Locations: BFS over shipments carrying a contaminated lot (root or downstream),
 *   starting from every location such a lot was shipped from. A location is affected
 *   when it is the destination of such a shipment; a pure origin (the factory) is not.
 * - Output order is BFS discovery order, so callers get stable ids (warehouses before stores).
 *
 * Throws "NOT_FOUND: ..." if the root lot does not exist.
 */
export function traceDownstream(input: TraceInput): TraceResult {
  const { rootLotId, lots, lotEdges, shipments, shipmentLines, locations } = input;

  if (!lots.some((l) => l.lotId === rootLotId)) {
    throw new Error(`NOT_FOUND: lot ${rootLotId} does not exist`);
  }

  // ---- Lots: parent -> children adjacency, then BFS.
  const children = new Map<string, string[]>();
  for (const e of lotEdges) {
    const list = children.get(e.parentLotId);
    if (list) list.push(e.childLotId);
    else children.set(e.parentLotId, [e.childLotId]);
  }

  const contaminated = new Set<string>([rootLotId]);
  const affectedLotIds: string[] = [];
  const lotQueue = [rootLotId];
  for (let i = 0; i < lotQueue.length; i++) {
    for (const child of children.get(lotQueue[i]) ?? []) {
      if (contaminated.has(child)) continue;
      contaminated.add(child);
      affectedLotIds.push(child);
      lotQueue.push(child);
    }
  }

  // ---- Locations: shipments that carry a contaminated lot, as from -> to adjacency.
  const shipmentById = new Map(shipments.map((s) => [s.shipmentId, s]));
  const knownLocations = new Set(locations.map((l) => l.id));
  const outbound = new Map<string, string[]>();
  const hasInbound = new Set<string>();
  const seenShipments = new Set<string>();
  for (const line of shipmentLines) {
    if (!contaminated.has(line.lotId) || seenShipments.has(line.shipmentId)) continue;
    const s = shipmentById.get(line.shipmentId);
    if (!s) continue;
    seenShipments.add(line.shipmentId);
    const list = outbound.get(s.fromLocation);
    if (list) list.push(s.toLocation);
    else outbound.set(s.fromLocation, [s.toLocation]);
    hasInbound.add(s.toLocation);
  }

  // Start from origins (senders that never received contaminated stock), then any
  // remaining senders so disconnected sub-networks are still covered.
  const senders = [...outbound.keys()];
  const starts = [...senders.filter((l) => !hasInbound.has(l)), ...senders.filter((l) => hasInbound.has(l))];

  const visited = new Set<string>();
  const affected = new Set<string>();
  const affectedLocationIds: string[] = [];
  for (const start of starts) {
    if (visited.has(start)) continue;
    visited.add(start);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const to of outbound.get(queue[i]) ?? []) {
        if (!affected.has(to) && knownLocations.has(to)) {
          affected.add(to);
          affectedLocationIds.push(to);
        }
        if (!visited.has(to)) {
          visited.add(to);
          queue.push(to);
        }
      }
    }
  }

  return { affectedLotIds, affectedLocationIds };
}
