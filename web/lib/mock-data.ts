// Mock DataSource: in-memory copy of fixtures/ that simulates the full recall flow
// (PLAN.md section 12) so every screen can be built and demoed without SpacetimeDB:
//   startRecall -> signal -> authorize -> trace -> assign (one step per beat)
//   CONNECTED stores: agent claims + quarantines, except MOCK_OFFLINE_AGENTS, whose
//   task times out every TASK_LEASE_MS and escalates -> INVENTORY_UNKNOWN.
//   MANUAL stores: wait for confirmQuarantine from the store terminal.
// Trace and reconciliation numbers come from Prathamesh's pure functions, the same
// ones trace_recall calls, so the mock matches the real backend.
// State lives in this browser tab; navigate between pages with links to keep it.

import type {
  AffectedLocation,
  ContainmentTask,
  InventoryEvent,
  Organization,
} from "../../shared/contracts/tables";
import { TASK_LEASE_MS, TASK_MAX_RETRIES, TIMEOUT_CHECK_INTERVAL_MS } from "../../shared/contracts/tables";
import { reconcileLocation } from "../../spacetimedb/src/reconcile";
import { traceDownstream } from "../../spacetimedb/src/trace";
import organizations from "../../fixtures/organizations.json";
import locations from "../../fixtures/locations.json";
import products from "../../fixtures/products.json";
import lots from "../../fixtures/lots.json";
import lotEdges from "../../fixtures/lot_edges.json";
import shipments from "../../fixtures/shipments.json";
import shipmentLines from "../../fixtures/shipment_lines.json";
import inventoryBalances from "../../fixtures/inventory_balances.json";
import inventoryEvents from "../../fixtures/inventory_events.json";
import type { ActionResult, DataSource, Snapshot } from "./data";

/** Demo: Store B's agent is "killed", so its task escalates. */
const MOCK_OFFLINE_AGENTS = ["STORE-B"];
/** Delay between coordinator steps and agent actions, ms. */
const BEAT_MS = 900;

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  let events = inventoryEvents as InventoryEvent[];
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;

  const listeners = new Set<() => void>();
  const commit = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((l) => l());
  };
  const audit = (recallId: string | null, actor: string, action: string, detail: string) => {
    commit({
      auditEvents: [
        ...snap.auditEvents,
        { id: snap.auditEvents.length + 1, recallId, actor, action, detail, at: now() },
      ],
    });
  };
  const fail = (code: Extract<ActionResult, { ok: false }>["code"], message: string): ActionResult => ({
    ok: false,
    code,
    message,
  });

  const orgOf = (locationId: string) => {
    const loc = snap.locations.find((l) => l.id === locationId)!;
    return snap.organizations.find((o) => o.id === loc.orgId)!;
  };
  const updateTask = (taskId: string, patch: Partial<ContainmentTask>) =>
    commit({ containmentTasks: snap.containmentTasks.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t)) });
  const updateAffected = (recallId: string, locationId: string, patch: Partial<AffectedLocation>) =>
    commit({
      affectedLocations: snap.affectedLocations.map((a) =>
        a.recallId === recallId && a.locationId === locationId ? { ...a, ...patch } : a,
      ),
    });

  // ---------- Reducer equivalents ----------

  function traceRecall(recallId: string, rootLotId: string) {
    const { affectedLotIds, affectedLocationIds } = traceDownstream({ rootLotId, ...snap });
    const finished = affectedLotIds.filter((id) => snap.lots.find((l) => l.lotId === id)?.kind === "FINISHED");
    // Like the gateway mock: only stores hold containable stock.
    const storeIds = affectedLocationIds.filter(
      (id) => snap.locations.find((l) => l.id === id)?.type === "STORE",
    );
    const affected = storeIds.map((locationId): AffectedLocation => {
      const r = reconcileLocation({
        locationId,
        lotIds: finished,
        shipments: snap.shipments,
        shipmentLines: snap.shipmentLines,
        events,
        balances: snap.inventoryBalances,
      });
      return {
        recallId,
        locationId,
        status: r.unaccountedUnits > 0 ? "RECONCILIATION_EXCEPTION" : "AWAITING_ACKNOWLEDGMENT",
        expectedUnits: r.expectedUnits,
        soldUnits: r.soldUnits,
        quarantinedUnits: r.quarantinedUnits,
        unaccountedUnits: r.unaccountedUnits,
        lostInTransitUnits: r.lostInTransitUnits,
        dispositionNote: null,
      };
    });
    commit({
      affectedLots: [...snap.affectedLots, ...finished.map((lotId) => ({ recallId, lotId }))],
      affectedLocations: [...snap.affectedLocations, ...affected],
      recalls: snap.recalls.map((r) => (r.recallId === recallId ? { ...r, status: "TRACED" } : r)),
    });
    audit(recallId, "ORG-ACME", "trace_recall", `Affected lots ${finished.join(", ")}; ${affected.length} locations: ${storeIds.join(", ")}`);
    for (const a of affected.filter((a) => a.unaccountedUnits > 0)) {
      audit(recallId, "system", "record_discrepancy", `${a.locationId}: ${a.unaccountedUnits} units unaccounted`);
    }
    return finished;
  }

  function assignTasks(recallId: string, lotIds: string[]) {
    const locs = snap.affectedLocations.filter((a) => a.recallId === recallId);
    const base = snap.containmentTasks.length;
    const tasks = locs.map((a, i): ContainmentTask => {
      const connected = orgOf(a.locationId).integrationLevel === "CONNECTED";
      return {
        taskId: `T-${base + i + 1}`,
        recallId,
        locationId: a.locationId,
        lotIds: lotIds.filter((l) => snap.inventoryBalances.some((b) => b.lotId === l && b.locationId === a.locationId)),
        state: "PENDING",
        attempts: connected ? 1 : 0,
        leaseExpiresAt: connected ? new Date(Date.now() + TASK_LEASE_MS).toISOString() : null,
        dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    });
    commit({
      containmentTasks: [...snap.containmentTasks, ...tasks],
      recalls: snap.recalls.map((r) => (r.recallId === recallId ? { ...r, status: "CONTAINING" } : r)),
    });
    audit(recallId, "ORG-ACME", "assign_containment_tasks", `${tasks.length} tasks assigned`);
    if (!timeoutTimer) timeoutTimer = setInterval(checkTimeouts, TIMEOUT_CHECK_INTERVAL_MS);
    return tasks;
  }

  function claim(taskId: string, actor: string) {
    const t = snap.containmentTasks.find((x) => x.taskId === taskId)!;
    const attempts = Math.max(1, t.attempts);
    updateTask(taskId, { state: "CLAIMED", attempts, leaseExpiresAt: new Date(Date.now() + TASK_LEASE_MS).toISOString() });
    audit(t.recallId, actor, "claim_task", `${taskId} claimed by ${actor} (attempt ${attempts})`);
  }

  /** Idempotent, like quarantine_lot. */
  function quarantine(taskId: string, actor: string): ActionResult {
    const t = snap.containmentTasks.find((x) => x.taskId === taskId);
    if (!t) return fail("NOT_FOUND", `Task ${taskId} not found`);
    if (t.state === "VERIFIED") return { ok: true };
    if (t.state === "ESCALATED") return fail("INVALID_STATE", `${taskId} already escalated`);
    let moved = 0;
    commit({
      inventoryBalances: snap.inventoryBalances.map((b) => {
        if (b.locationId !== t.locationId || !t.lotIds.includes(b.lotId) || b.available === 0) return b;
        moved += b.available;
        events = [
          ...events,
          { id: events.length + 1, lotId: b.lotId, locationId: b.locationId, type: "QUARANTINED", qty: b.available, at: now(), actor },
        ];
        return { ...b, quarantined: b.quarantined + b.available, available: 0 };
      }),
    });
    const a = snap.affectedLocations.find((x) => x.recallId === t.recallId && x.locationId === t.locationId)!;
    updateAffected(t.recallId, t.locationId, {
      quarantinedUnits: a.quarantinedUnits + moved,
      status: a.status === "RECONCILIATION_EXCEPTION" ? a.status : "VERIFIED_CONTAINED",
    });
    updateTask(taskId, { state: "VERIFIED", leaseExpiresAt: null });
    audit(t.recallId, actor, "quarantine_lot", `${t.locationId}: ${moved} units of ${t.lotIds.join(", ")} quarantined`);
    return { ok: true };
  }

  /** Mirrors the check_task_timeouts scheduled reducer. */
  function checkTimeouts() {
    const t0 = Date.now();
    for (const t of snap.containmentTasks) {
      if (t.state === "VERIFIED" || t.state === "ESCALATED" || !t.leaseExpiresAt || Date.parse(t.leaseExpiresAt) > t0) continue;
      if (t.attempts > TASK_MAX_RETRIES) {
        updateTask(t.taskId, { state: "ESCALATED", leaseExpiresAt: null });
        const a = snap.affectedLocations.find((x) => x.recallId === t.recallId && x.locationId === t.locationId);
        if (a && a.status !== "VERIFIED_CONTAINED") updateAffected(t.recallId, t.locationId, { status: "INVENTORY_UNKNOWN" });
        audit(t.recallId, "system", "check_task_timeouts", `${t.taskId} escalated after ${t.attempts} attempts; ${t.locationId} INVENTORY_UNKNOWN`);
      } else {
        updateTask(t.taskId, {
          state: "RETRY_PENDING",
          attempts: t.attempts + 1,
          leaseExpiresAt: new Date(t0 + TASK_LEASE_MS).toISOString(),
        });
        audit(t.recallId, "system", "check_task_timeouts", `${t.taskId} timed out (attempt ${t.attempts}), retry pending`);
        audit(t.recallId, "ORG-ACME", "coordinator", `QUARANTINE_REQUEST resent to ${t.locationId} agent (${t.taskId})`);
      }
    }
  }

  /** What the retailer agent does on QUARANTINE_REQUEST. */
  async function simulateAgent(task: ContainmentTask) {
    const org = orgOf(task.locationId);
    audit(task.recallId, "ORG-ACME", "coordinator", `QUARANTINE_REQUEST sent to ${task.locationId} agent (${task.taskId})`);
    if (MOCK_OFFLINE_AGENTS.includes(task.locationId)) return; // no reply; timeouts take over
    await sleep(BEAT_MS * 2);
    claim(task.taskId, org.id);
    await sleep(BEAT_MS);
    quarantine(task.taskId, org.id);
    const a = snap.affectedLocations.find((x) => x.recallId === task.recallId && x.locationId === task.locationId)!;
    audit(task.recallId, org.id, "agent", `QUARANTINE_RESULT ${task.taskId}: ${a.status}, ${a.quarantinedUnits} units`);
  }

  async function runFlow(recallId: string, rootLotId: string) {
    await sleep(BEAT_MS);
    commit({ recalls: snap.recalls.map((r) => (r.recallId === recallId ? { ...r, status: "AUTHORIZED" } : r)) });
    audit(recallId, "ORG-ACME", "authorize_recall", `${recallId} authorized`);
    await sleep(BEAT_MS);
    const lotIds = traceRecall(recallId, rootLotId);
    await sleep(BEAT_MS);
    const tasks = assignTasks(recallId, lotIds);
    for (const t of tasks) {
      if (orgOf(t.locationId).integrationLevel === "CONNECTED") void simulateAgent(t);
    }
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async startRecall(rootLotId, reason) {
      if (!snap.lots.some((l) => l.lotId === rootLotId)) return fail("NOT_FOUND", `Lot ${rootLotId} not found`);
      const open = snap.recalls.find((r) => r.rootLotId === rootLotId && r.status !== "CLOSED");
      if (open) return fail("INVALID_STATE", `${open.recallId} is already open for ${rootLotId}`);
      const recallId = `REC-${String(snap.recalls.length + 1).padStart(3, "0")}`;
      commit({
        recalls: [
          ...snap.recalls,
          { recallId, rootLotId, reason, status: "SIGNAL", createdBy: "ORG-ACME", createdAt: now() },
        ],
      });
      audit(recallId, "ORG-ACME", "report_recall_signal", `Signal for ${rootLotId}: ${reason}`);
      void runFlow(recallId, rootLotId);
      return { ok: true };
    },

    async recordSale(locationId, lotId, qty) {
      if (!Number.isInteger(qty) || qty <= 0) return fail("INVALID_ARGUMENT", "Quantity must be a positive whole number");
      const b = snap.inventoryBalances.find((b) => b.locationId === locationId && b.lotId === lotId);
      if (!b) return fail("NOT_FOUND", `No stock of ${lotId} at ${locationId}`);
      if (b.quarantined > 0) {
        const task = snap.containmentTasks.find((t) => t.locationId === locationId && t.lotIds.includes(lotId));
        return fail("LOT_QUARANTINED", `Sale blocked: lot ${lotId} under recall ${task?.recallId ?? "unknown"}`);
      }
      if (b.available < qty) return fail("INSUFFICIENT_STOCK", `Only ${b.available} of ${lotId} available`);
      events = [...events, { id: events.length + 1, lotId, locationId, type: "SOLD", qty, at: now(), actor: orgOf(locationId).id }];
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
      const actor = orgOf(task.locationId).id;
      if (task.state !== "VERIFIED" && task.state !== "ESCALATED") claim(taskId, actor);
      return quarantine(taskId, actor);
    },
  };
}
