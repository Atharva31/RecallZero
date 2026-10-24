# Fixtures (PLAN.md section 6)

Owner: Prathamesh. Seed data loaded by the web mock, the gateway mock and (later) `seed_fixtures`.
Shapes are the contract types in `shared/contracts/tables.ts` (camelCase, ISO timestamps).

Notes:
- Finished-good lots use `lotId == sku` (one lot per product): BAR-100, BAR-101, BAR-102.
- Ingredient `quantity` is kg; finished-good `quantity` is units.
- `inventory_balances.json` is the **counted** current stock. `inventory_events.json` holds RECEIVED and SOLD events.
  For Store D the events say 120 received − 85 sold = 35, but the count is 20, so **15 units are unaccounted**
  (`RECONCILIATION_EXCEPTION`). SHP-006 dispatched 130 but received 120: **10 lost in transit**.
- Warehouses received everything and shipped it all onward (no DISPATCHED event type), so their balances are 0.
- Each store is its own RETAILER org so ownership checks (`claim_task`, `quarantine_lot`) mean something.
- Identities are not in fixtures; the gateway binds them at runtime (`claim_org_identity`).
