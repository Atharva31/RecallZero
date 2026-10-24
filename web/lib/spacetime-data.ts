// NEXT_PUBLIC_DATA_SOURCE=spacetimedb: live data from SpacetimeDB, writes through the gateway.
//
// Reads: one anonymous, read-only connection subscribed to every table; each committed
// change rebuilds the Snapshot. The browser never claims an org identity.
// Writes: HTTP to the gateway, which calls the reducer as the right org's identity
// (fallback recall as ORG-ACME; POS and "Confirm quarantine" as the store's own org).
// The coordinator agent adopts recalls started here and dispatches the retailer agents.

import type { ErrorBody } from "../../shared/contracts/gateway";
import { parseReducerError } from "../../shared/contracts/reducers";
import * as rows from "../../shared/rows";
import type { ActionResult, DataSource, Snapshot } from "./data";
import { DbConnection } from "./module_bindings";

const SPACETIMEDB_URL = process.env.NEXT_PUBLIC_SPACETIMEDB_URL ?? "ws://localhost:3000";
const SPACETIMEDB_DB = process.env.NEXT_PUBLIC_SPACETIMEDB_DB ?? "recallzero";
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";
const MANUFACTURER_ORG = "ORG-ACME";

const EMPTY: Snapshot = {
  organizations: [],
  locations: [],
  products: [],
  lots: [],
  lotEdges: [],
  shipments: [],
  shipmentLines: [],
  inventoryBalances: [],
  recalls: [],
  affectedLots: [],
  affectedLocations: [],
  containmentTasks: [],
  auditEvents: [],
};

function toSnapshot(conn: DbConnection): Snapshot {
  const db = conn.db;
  return {
    organizations: [...db.organizations.iter()].map(rows.toOrganization),
    locations: [...db.locations.iter()].map(rows.toLocation),
    products: [...db.products.iter()].map(rows.toProduct),
    lots: [...db.lots.iter()].map(rows.toLot),
    lotEdges: [...db.lotEdges.iter()].map(rows.toLotEdge),
    shipments: [...db.shipments.iter()].map(rows.toShipment),
    shipmentLines: [...db.shipmentLines.iter()].map(rows.toShipmentLine),
    inventoryBalances: [...db.inventoryBalances.iter()].map(rows.toInventoryBalance),
    recalls: [...db.recalls.iter()].map(rows.toRecall).sort((a, b) => a.recallId.localeCompare(b.recallId)),
    affectedLots: [...db.affectedLots.iter()].map(rows.toAffectedLot),
    affectedLocations: [...db.affectedLocations.iter()]
      .map(rows.toAffectedLocation)
      .sort((a, b) => a.locationId.localeCompare(b.locationId)),
    containmentTasks: [...db.containmentTasks.iter()]
      .map(rows.toContainmentTask)
      .sort((a, b) => Number(a.taskId.slice(2)) - Number(b.taskId.slice(2))),
    auditEvents: [...db.auditEvents.iter()].map(rows.toAuditEvent).sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id),
  };
}

type Failure = Extract<ActionResult, { ok: false }>;

/** POST to the gateway as `orgId`. Returns the response body, or the reducer error. */
async function post<T = object>(orgId: string, path: string, body?: object): Promise<({ ok: true } & T) | Failure> {
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as ({ ok: true } & T) | ErrorBody;
    if (json.ok) return json;
    return { ok: false, ...parseReducerError(`${json.error.code}: ${json.error.message}`) };
  } catch (e) {
    return { ok: false, code: "UNKNOWN", message: `Gateway unreachable at ${GATEWAY_URL}: ${(e as Error).message}` };
  }
}

const done = (r: { ok: true } | Failure): ActionResult => (r.ok ? { ok: true } : r);

export function createSpacetimeDataSource(): DataSource {
  let snap = EMPTY;
  const listeners = new Set<() => void>();
  let conn: DbConnection | null = null;
  let scheduled = false;

  // Many row callbacks fire per transaction: rebuild once per tick.
  const refresh = () => {
    if (scheduled || !conn) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!conn) return;
      snap = toSnapshot(conn);
      listeners.forEach((l) => l());
    });
  };

  function connect() {
    if (conn || typeof window === "undefined") return; // never connect during server rendering
    conn = DbConnection.builder()
      .withUri(SPACETIMEDB_URL)
      .withDatabaseName(SPACETIMEDB_DB)
      .onConnect((c) => {
        for (const table of Object.values(c.db) as {
          onInsert?: (cb: () => void) => void;
          onDelete?: (cb: () => void) => void;
          onUpdate?: (cb: () => void) => void;
        }[]) {
          table.onInsert?.(refresh);
          table.onDelete?.(refresh);
          table.onUpdate?.(refresh);
        }
        c.subscriptionBuilder().onApplied(refresh).subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => console.error("SpacetimeDB connection failed", err))
      .onDisconnect(() => {
        console.warn("SpacetimeDB disconnected; reconnecting in 2 s");
        conn = null;
        setTimeout(connect, 2000);
      })
      .build();
  }

  const orgOf = (locationId: string) => snap.locations.find((l) => l.id === locationId)?.orgId;

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      connect();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async startRecall(rootLotId, reason) {
      const signal = await post<{ recall: { recallId: string } }>(MANUFACTURER_ORG, "/recalls", { rootLotId, reason });
      if (!signal.ok) return signal;
      const id = signal.recall.recallId;
      for (const step of ["authorize", "trace", "assign"]) {
        const r = await post(MANUFACTURER_ORG, `/recalls/${id}/${step}`);
        if (!r.ok) return r;
      }
      return { ok: true };
    },

    async recordSale(locationId, lotId, qty) {
      const orgId = orgOf(locationId);
      if (!orgId) return { ok: false, code: "NOT_FOUND", message: `Location ${locationId} not found` };
      return done(await post(orgId, "/sales", { locationId, lotId, qty }));
    },

    async confirmQuarantine(taskId) {
      const task = snap.containmentTasks.find((t) => t.taskId === taskId);
      if (!task) return { ok: false, code: "NOT_FOUND", message: `Task ${taskId} not found` };
      const orgId = orgOf(task.locationId)!;
      return done(await post(orgId, `/tasks/${taskId}/quarantine`));
    },
  };
}
