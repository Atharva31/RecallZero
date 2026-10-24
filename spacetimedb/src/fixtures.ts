// seed_fixtures: dev only. Wipes every table and reloads fixtures/ (PLAN.md section 6).
// Fixture JSON is bundled into the module at build time.

import spacetimedb from './schema';
import { audit } from './audit';
import { fromIso, type Ctx } from './common';
import { requireAdmin } from './permissions';
import { ensureTimeoutTimer } from './tasks';

import organizations from '../../fixtures/organizations.json';
import locations from '../../fixtures/locations.json';
import products from '../../fixtures/products.json';
import lots from '../../fixtures/lots.json';
import lotEdges from '../../fixtures/lot_edges.json';
import shipments from '../../fixtures/shipments.json';
import shipmentLines from '../../fixtures/shipment_lines.json';
import inventoryEvents from '../../fixtures/inventory_events.json';
import inventoryBalances from '../../fixtures/inventory_balances.json';

function wipe(ctx: Ctx) {
  const db = ctx.db;
  for (const r of [...db.organizations.iter()]) db.organizations.id.delete(r.id);
  for (const r of [...db.locations.iter()]) db.locations.id.delete(r.id);
  for (const r of [...db.products.iter()]) db.products.sku.delete(r.sku);
  for (const r of [...db.lots.iter()]) db.lots.lotId.delete(r.lotId);
  for (const r of [...db.lotEdges.iter()]) db.lotEdges.id.delete(r.id);
  for (const r of [...db.shipments.iter()]) db.shipments.shipmentId.delete(r.shipmentId);
  for (const r of [...db.shipmentLines.iter()]) db.shipmentLines.id.delete(r.id);
  for (const r of [...db.inventoryEvents.iter()]) db.inventoryEvents.id.delete(r.id);
  for (const r of [...db.inventoryBalances.iter()]) db.inventoryBalances.id.delete(r.id);
  for (const r of [...db.recalls.iter()]) db.recalls.recallId.delete(r.recallId);
  for (const r of [...db.affectedLots.iter()]) db.affectedLots.id.delete(r.id);
  for (const r of [...db.affectedLocations.iter()]) db.affectedLocations.id.delete(r.id);
  for (const r of [...db.containmentTasks.iter()]) db.containmentTasks.taskId.delete(r.taskId);
  for (const r of [...db.taskAttempts.iter()]) db.taskAttempts.id.delete(r.id);
  for (const r of [...db.auditEvents.iter()]) db.auditEvents.id.delete(r.id);
}

export function loadFixtures(ctx: Ctx) {
  const db = ctx.db;
  for (const o of organizations) db.organizations.insert({ ...o, identity: undefined });
  for (const l of locations) db.locations.insert(l);
  for (const p of products) db.products.insert(p);
  for (const l of lots) db.lots.insert({ ...l, sku: l.sku ?? undefined, producedAt: fromIso(l.producedAt) });
  for (const e of lotEdges) db.lotEdges.insert({ id: 0n, ...e });
  for (const s of shipments) db.shipments.insert(s);
  for (const l of shipmentLines) db.shipmentLines.insert({ id: 0n, ...l });
  for (const { id: _id, ...e } of inventoryEvents) db.inventoryEvents.insert({ id: 0n, ...e, at: fromIso(e.at) });
  for (const b of inventoryBalances) db.inventoryBalances.insert({ id: 0n, ...b });
}

/** Clears all identity bindings: the gateway re-claims its orgs after a reset. */
export const seedFixtures = spacetimedb.reducer(ctx => {
  requireAdmin(ctx);
  wipe(ctx);
  loadFixtures(ctx);
  const cfg = ctx.db.config.id.find(0)!;
  ctx.db.config.id.update({ ...cfg, nextRecallNo: 1, nextTaskNo: 1 });
  ensureTimeoutTimer(ctx);
  audit(ctx, null, 'admin', 'seed_fixtures', 'Fixtures loaded; all org identities unbound');
});
