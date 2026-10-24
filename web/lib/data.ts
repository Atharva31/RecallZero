// The only way UI components read or change data.
// mock-data.ts: in-browser mock reading fixtures/. spacetime-data.ts: live SpacetimeDB
// subscriptions for reads, gateway HTTP for writes. Same interface, so components do
// not change. Select with NEXT_PUBLIC_DATA_SOURCE=mock|spacetimedb.

import { useSyncExternalStore } from "react";

import type { ErrorCode } from "../../shared/contracts/reducers";
import type {
  AffectedLocation,
  AffectedLot,
  AuditEvent,
  ContainmentTask,
  InventoryBalance,
  Location,
  Lot,
  LotEdge,
  Organization,
  Product,
  Recall,
  Shipment,
  ShipmentLine,
} from "../../shared/contracts/tables";
import { createMockDataSource } from "./mock-data";
import { createSpacetimeDataSource } from "./spacetime-data";

/** Everything the UI renders, in contract (tables.ts) shapes. Treat as immutable. */
export interface Snapshot {
  organizations: Organization[];
  locations: Location[];
  products: Product[];
  lots: Lot[];
  lotEdges: LotEdge[];
  shipments: Shipment[];
  shipmentLines: ShipmentLine[];
  inventoryBalances: InventoryBalance[];
  recalls: Recall[];
  affectedLots: AffectedLot[];
  affectedLocations: AffectedLocation[];
  containmentTasks: ContainmentTask[];
  auditEvents: AuditEvent[];
}

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode | "UNKNOWN"; message: string };

export interface DataSource {
  getSnapshot(): Snapshot;
  /** Called on every committed change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;

  /** Command center fallback button: same flow as the coordinator, without ASI:One. */
  startRecall(rootLotId: string, reason: string): Promise<ActionResult>;
  /** Store terminal POS. Fails with LOT_QUARANTINED -> show "Sale blocked: ...". */
  recordSale(locationId: string, lotId: string, qty: number): Promise<ActionResult>;
  /** MANUAL store "Confirm quarantine" button. */
  confirmQuarantine(taskId: string): Promise<ActionResult>;
}

let source: DataSource | null = null;

export function getDataSource(): DataSource {
  if (!source) {
    source =
      process.env.NEXT_PUBLIC_DATA_SOURCE === "spacetimedb" ? createSpacetimeDataSource() : createMockDataSource();
  }
  return source;
}

/** React hook: live snapshot that re-renders on every change. */
export function useData(): Snapshot {
  const ds = getDataSource();
  return useSyncExternalStore(ds.subscribe, ds.getSnapshot, ds.getSnapshot);
}
