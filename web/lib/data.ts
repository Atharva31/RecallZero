// The only way UI components read or change data.
// Today: mock reading fixtures/ (mock-data.ts). Later: SpacetimeDB subscriptions
// using the generated bindings in lib/module_bindings, behind this same interface,
// so components do not change. Select with NEXT_PUBLIC_DATA_SOURCE=mock|spacetimedb.

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
    const kind = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";
    if (kind !== "mock") {
      // TODO(Renuka, Sat midday): createSpacetimeDataSource() using lib/module_bindings.
      console.warn(`NEXT_PUBLIC_DATA_SOURCE=${kind} not implemented yet, using mock`);
    }
    source = createMockDataSource();
  }
  return source;
}

/** React hook: live snapshot that re-renders on every change. */
export function useData(): Snapshot {
  const ds = getDataSource();
  return useSyncExternalStore(ds.subscribe, ds.getSnapshot, ds.getSnapshot);
}
