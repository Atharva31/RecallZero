// Mock DataSource: in-memory copy of fixtures/. Good enough to build every screen.
// recordSale implements the quarantine rejection; startRecall/confirmQuarantine are
// minimal and meant to be extended (Renuka) to simulate the full flow on mock data.

import type { Organization } from "../../shared/contracts/tables";
import organizations from "../../fixtures/organizations.json";
import locations from "../../fixtures/locations.json";
import products from "../../fixtures/products.json";
import lots from "../../fixtures/lots.json";
import lotEdges from "../../fixtures/lot_edges.json";
import shipments from "../../fixtures/shipments.json";
import shipmentLines from "../../fixtures/shipment_lines.json";
import inventoryBalances from "../../fixtures/inventory_balances.json";
import type { ActionResult, DataSource, Snapshot } from "./data";

export function createMockDataSource(): DataSource {
  let snap: Snapshot = {
    organizations: organizations.map((o) => ({ ...o, identity: null }) as Organization),
    locations: locations as Snapshot["locations"],
    products,
    lots: lots as Snapshot["lots"],
    lotEdges,
    shipments: shipments as Snapshot["shipments"],
    shipmentLines,
    inventoryBalances,
    recalls: [],
    affectedLots: [],
    affectedLocations: [],
    containmentTasks: [],
    auditEvents: [],
  };
  const listeners = new Set<() => void>();
  const commit = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((l) => l());
  };
  const audit = (recallId: string | null, actor: string, action: string, detail: string) => [
    ...snap.auditEvents,
    { id: snap.auditEvents.length + 1, recallId, actor, action, detail, at: new Date().toISOString() },
  ];
  const fail = (code: Extract<ActionResult, { ok: false }>["code"], message: string): ActionResult => ({
    ok: false,
    code,
    message,
  });

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async startRecall(rootLotId, reason) {
      if (!snap.lots.some((l) => l.lotId === rootLotId)) return fail("NOT_FOUND", `Lot ${rootLotId} not found`);
      const recallId = `REC-${String(snap.recalls.length + 1).padStart(3, "0")}`;
      commit({
        recalls: [
          ...snap.recalls,
          { recallId, rootLotId, reason, status: "SIGNAL", createdBy: "ORG-ACME", createdAt: new Date().toISOString() },
        ],
        auditEvents: audit(recallId, "ORG-ACME", "report_recall_signal", `Signal for ${rootLotId}: ${reason}`),
      });
      // TODO(Renuka): simulate authorize -> trace -> assign -> agent results on a timer.
      return { ok: true };
    },

    async recordSale(locationId, lotId, qty) {
      const b = snap.inventoryBalances.find((b) => b.locationId === locationId && b.lotId === lotId);
      if (!b) return fail("NOT_FOUND", `No stock of ${lotId} at ${locationId}`);
      if (b.quarantined > 0) {
        const task = snap.containmentTasks.find((t) => t.locationId === locationId && t.lotIds.includes(lotId));
        return fail("LOT_QUARANTINED", `Sale blocked: lot ${lotId} under recall ${task?.recallId ?? "unknown"}`);
      }
      if (b.available < qty) return fail("INSUFFICIENT_STOCK", `Only ${b.available} of ${lotId} available`);
      commit({
        inventoryBalances: snap.inventoryBalances.map((x) =>
          x === b ? { ...x, available: x.available - qty, sold: x.sold + qty } : x,
        ),
      });
      return { ok: true };
    },

    async confirmQuarantine(taskId) {
      const task = snap.containmentTasks.find((t) => t.taskId === taskId);
      if (!task) return fail("NOT_FOUND", `Task ${taskId} not found`);
      // TODO(Renuka): move available -> quarantined and mark the location VERIFIED_CONTAINED.
      return { ok: true };
    },
  };
}
