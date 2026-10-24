# RecallZero — Build Plan (Cal Hacks 13)

> Instructions for Claude Code. Read this whole file before writing code.
> **Target: feature-complete by Saturday Oct 24, 7:00 PM PT.** Saturday night is for rehearsal, video and Devpost.
> Hard deadline: **Sunday Oct 25, 9:00 AM PT**.
> Team: Atharva, Sarvesh, Renuka, Prathamesh. Build one working vertical slice, not the full product.
> **Do section 0 first, commit it, and only then start the per-person work in section 11.**

## 0. First step: base template (commit before anything else)

Goal: one commit on `main` that gives all four people a running skeleton and frozen contracts, so they can build in parallel without waiting on each other. Owner: **Atharva**, Fri 7:15–8:15 PM. Everyone else does their section 11 "while template is built" tasks.

The base template must contain:

1. **Folder structure** exactly as in section 4, with a root `README.md` listing the run command for each part.
2. **`shared/contracts/`**, the single source of truth everyone codes against:
   - `tables.ts`: TypeScript types for every table in section 5 and every status enum in section 7.
   - `reducers.ts`: reducer names, argument types and return/error shapes from section 8.
   - `gateway.ts`: gateway endpoint paths, request and response JSON shapes.
   - `messages.json`: JSON Schema for `QUARANTINE_REQUEST` and `QUARANTINE_RESULT` (section 9), mirrored as Pydantic models in `agents/shared/messages.py`.
3. **`fixtures/*.json`** with the section 6 data (Prathamesh drafts this in parallel; Atharva drops it in).
4. **Skeletons that run:**
   - SpacetimeDB TypeScript module with all tables defined and one `ping` reducer; publishes to a local SpacetimeDB.
   - Next.js app with empty `/command` and `/store/[id]` pages, Tailwind, React Flow installed, and a `web/lib/data.ts` interface with a **mock implementation that reads `fixtures/`**.
   - Express gateway with every endpoint from `gateway.ts` returning **mock responses** from fixtures.
   - Coordinator and retailer uAgents that boot and log their addresses.
5. `.env.example` (Anthropic key, Agentverse key, SpacetimeDB URL, gateway URL, `STORE_ID`), `.gitignore`, and one `npm run dev` per app.

Then: `git add -A && git commit -m "Base template: skeletons, contracts, fixtures" && git push`. Everyone pulls and creates their own branch (`atharva/db`, `sarvesh/agents`, `renuka/web`, `prathamesh/trace`).

**Contract rule:** after this commit, files in `shared/contracts/` change only by Atharva, announced in the team chat first. Everyone else asks rather than editing them.

## 1. What we are building

RecallZero is an autonomous recall-execution network. When an ingredient lot is contaminated, it:

1. Traces every finished product made from that ingredient.
2. Finds every warehouse and store that received those products.
3. Dispatches AI agents (Fetch.ai) to each connected store to quarantine stock.
4. Blocks sales of quarantined lots at a simulated checkout.
5. Tracks which stores confirmed, which failed, and which are unknown.
6. Produces a final report that separates verified facts from unverified ones.

**The one chain that must work end to end (everything else is secondary):**

> Contaminated ingredient → 2 affected products → downstream stores discovered → agents quarantine stock → checkout rejected → one unresponsive store flagged, not faked → verified report.

**Core principle:** the system must distinguish what it knows from what it cannot verify. A store that hasn't responded is `INVENTORY_UNKNOWN` or `AWAITING_ACKNOWLEDGMENT`, never assumed contained. LLMs explain and parse; deterministic reducers own every state change.

## 2. Scope rules (do not violate)

- **One web app**, not three. Next.js with routes for the command center and the store terminal.
- **One Node gateway process** for agent → database calls. No microservices.
- **Agents:** one coordinator agent + one retailer agent codebase run as 2 instances (Store A, Store B). Compliance logic lives inside the coordinator.
- **Seeded fixture data.** No real retailer integrations.
- **Apify is a stretch goal.** Do not start it until milestone M4 is done.
- **Auth:** simple per-organization identities checked in reducers. No user login system, no OAuth.
- Before using any SpacetimeDB or uAgents API, **check the current docs** (spacetimedb.com/docs, Fetch.ai uAgents/Agentverse docs). Do not guess API signatures.

## 3. Tech stack

| Layer | Choice |
| --- | --- |
| Database + backend logic | SpacetimeDB, TypeScript module (tables, reducers, scheduled reducers, subscriptions) |
| Web app | Next.js (App Router) + TypeScript + Tailwind, SpacetimeDB TypeScript client SDK |
| Supply-chain graph | React Flow |
| Agent gateway | Node + Express, holds one SpacetimeDB connection/identity per organization |
| Agents | Python, Fetch.ai `uagents`, chat protocol enabled so the coordinator is reachable from ASI:One, registered on Agentverse (mailbox) |
| LLM | Claude via Anthropic API, inside the coordinator only: parse the user's request, draft report prose |
| Stretch | Apify Actor fetching public recall notices (openFDA food enforcement as context only) |

## 4. Repository layout

```
recallzero/
├── spacetimedb/src/        # module: schema.ts, manufacturing.ts, shipments.ts,
│                           # inventory.ts, recalls.ts, tasks.ts, permissions.ts, audit.ts
├── web/                    # Next.js app
│   └── app/
│       ├── command/        # command center: graph, status table, report
│       └── store/[id]/     # store terminal: inventory + simulated POS
├── gateway/                # Express: agent-facing HTTP API → reducers
├── agents/
│   ├── coordinator/        # uAgent + chat protocol + Claude calls
│   └── retailer/           # uAgent, run twice with different env (STORE_A, STORE_B)
├── shared/contracts/       # frozen types, reducer + gateway + message contracts (section 0)
├── fixtures/               # seed JSON (see section 6)
├── scripts/                # seed.ts, reset.ts, demo-scenario.ts
└── tests/                  # trace, reconciliation, permissions, end-to-end
```

## 5. Data model (SpacetimeDB tables)

Event-sourced: every stock change is an `inventory_events` row; `inventory_balances` is the materialized current state. Both are updated in the same reducer.

| Table | Key fields |
| --- | --- |
| `organizations` | id, name, type (MANUFACTURER/DISTRIBUTOR/RETAILER/REGULATOR), identity, integration_level (MANUAL / CONNECTED) |
| `locations` | id, org_id, name, type (FACTORY/WAREHOUSE/STORE), x, y (for graph layout) |
| `products` | sku, gtin, name |
| `lots` | lot_id, sku (null for ingredients), kind (INGREDIENT/FINISHED), produced_at, quantity |
| `lot_edges` | parent_lot_id, child_lot_id, quantity_used |
| `shipments` | shipment_id, from_location, to_location, status (DISPATCHED/RECEIVED) |
| `shipment_lines` | shipment_id, lot_id, qty_dispatched, qty_received, qty_damaged |
| `inventory_events` | id, lot_id, location_id, type (RECEIVED/SOLD/DAMAGED/QUARANTINED/ADJUSTED), qty, at, actor |
| `inventory_balances` | lot_id, location_id, available, quarantined, sold, damaged |
| `recalls` | recall_id, root_lot_id, reason, status (SIGNAL/AUTHORIZED/TRACED/CONTAINING/CLOSED), created_by |
| `affected_lots` | recall_id, lot_id |
| `affected_locations` | recall_id, location_id, status (see section 7), expected_units, sold_units, quarantined_units, unaccounted_units |
| `containment_tasks` | task_id, recall_id, location_id, lot_ids, state, attempts, lease_expires_at, due_at |
| `task_attempts` | task_id, attempt_no, agent, result, at |
| `audit_events` | id, recall_id, actor, action, detail, at |

## 6. Seed fixtures (exact)

**Ingredients → products**

| Ingredient lot | Used in | Qty used |
| --- | --- | --- |
| PEANUT-009 | BAR-100 (Peanut Crunch Bar) | 300 kg |
| PEANUT-009 | BAR-101 (Trail Mix Bar) | 200 kg |
| OAT-015 | BAR-100 | 150 kg |
| OAT-016 | BAR-101 | 100 kg |
| OAT-017 | BAR-102 (Oat Honey Bar, **not affected**) | 150 kg |

BAR-102 exists to prove the trace does not over-include.

**Network:** FACTORY-01 → WAREHOUSE-02 (BAR-100, 600 units) and WAREHOUSE-03 (BAR-101, 300 units; BAR-102, 200 units).

| Store | Lot | Shipped | Received | Sold | Current stock | Integration | Demo role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Store A | BAR-100 | 200 | 200 | 80 | 120 | CONNECTED (agent) | Quarantines automatically |
| Store B | BAR-100 | 150 | 150 | 40 | 110 | CONNECTED (agent) | Agent killed live → escalation |
| Store C | BAR-100 | 120 | 120 | 30 | 90 | MANUAL | Confirms via store terminal button |
| Store D | BAR-100 | 130 | 120 | 85 | 20 | MANUAL | 15 units unaccounted → exception |
| Store E | BAR-101 | 300 | 300 | 100 | 200 | MANUAL | Confirms via terminal |
| Store F | BAR-102 | 200 | 200 | 50 | 150 | MANUAL | Must stay untouched |

Store D: 130 shipped, 120 received (10 lost in transit), 120 − 85 sold − 20 counted = **15 unaccounted** → `RECONCILIATION_EXCEPTION`.

## 7. Status model

**Affected location status:** `AWAITING_ACKNOWLEDGMENT`, `VERIFIED_CONTAINED`, `PARTIALLY_CONTAINED`, `INVENTORY_UNKNOWN`, `ACTION_FAILED`, `RECONCILIATION_EXCEPTION`. Only `VERIFIED_CONTAINED` counts as contained.

**Task states:** `PENDING → CLAIMED → IN_PROGRESS → VERIFIED`; `IN_PROGRESS → TIMED_OUT → RETRY_PENDING → (retry) | ESCALATED`. Max 2 retries, 20-second lease in demo mode (configurable).

**Coverage metrics (show both):**
- Location coverage = verified-contained locations ÷ affected locations.
- Unit coverage = quarantined unsold units ÷ known unsold affected units. Sold, lost-in-transit and unaccounted units are listed separately and never counted as contained.

## 8. Reducers (backend contract)

Every reducer checks `ctx.sender` against `organizations.identity` and the org's role. Never trust an `org_id` argument as proof of identity. Every state change appends an `audit_events` row.

| Reducer | Caller | Behavior |
| --- | --- | --- |
| `seed_fixtures` | admin (dev only) | Loads section 6 data |
| `record_sale(location, lot, qty)` | retailer / POS | **Rejects if lot is quarantined or available < qty.** Returns a clear error string the POS can show |
| `report_recall_signal(root_lot, reason)` | manufacturer / coordinator | Creates recall in `SIGNAL` |
| `authorize_recall(recall_id)` | manufacturer compliance identity | `SIGNAL → AUTHORIZED` |
| `trace_recall(recall_id)` | coordinator | BFS over `lot_edges` (downstream) then `shipment_lines` to locations, O(V+E). Writes `affected_lots` and `affected_locations` with expected/sold/unaccounted computed from events. → `TRACED` |
| `assign_containment_tasks(recall_id)` | coordinator | One task per affected location. → `CONTAINING` |
| `claim_task(task_id)` | retailer agent | Sets lease; only the owning org can claim |
| `quarantine_lot(task_id)` | retailer agent or manual terminal | Validates: recall authorized, lot affected, caller owns location, not already done (idempotent). Moves `available → quarantined`, writes event, marks location `VERIFIED_CONTAINED` unless reconciliation fails |
| `record_discrepancy(...)` | trace logic | Opens `RECONCILIATION_EXCEPTION` |
| `check_task_timeouts` | **scheduled reducer**, every 5 s | Expired lease → `TIMED_OUT` → retry or `ESCALATED`; location becomes `INVENTORY_UNKNOWN` |
| `close_recall(recall_id, note)` | manufacturer identity | Allowed only if every location is verified or has an explicit disposition note |

## 9. Agents

**Coordinator agent** (Python uAgent, chat protocol, registered on Agentverse so ASI:One can reach it)
- Receives natural language, e.g.: "Start an investigation for contaminated ingredient PEANUT-009 and contain it."
- Uses Claude only to extract `{root_lot, reason}`. Validate the lot exists via gateway before proceeding.
- Calls gateway: `report_recall_signal` → `authorize_recall` → `trace_recall` → `assign_containment_tasks`.
- Sends `QUARANTINE_REQUEST` to each CONNECTED store's retailer agent. MANUAL stores are handled in the UI.
- Polls state via gateway; when everything settles or escalates, uses Claude to draft the report prose **from committed database facts only**, and replies in chat.

**Retailer agent** (same code, 2 instances via env `STORE_ID=STORE-A|STORE-B`)
- On `QUARANTINE_REQUEST`: `claim_task` → check stock → `quarantine_lot` → reply with the committed result read back from the database, never its own claim.

**Message contract** (shared Pydantic models in `agents/shared/`):
```json
{"type": "QUARANTINE_REQUEST", "request_id": "REQ-204", "recall_id": "REC-001",
 "task_id": "T-7", "store_id": "STORE-A", "lot_ids": ["BAR-100"], "reason": "Authorized recall"}
{"type": "QUARANTINE_RESULT", "request_id": "REQ-204", "task_id": "T-7",
 "status": "VERIFIED_CONTAINED", "quarantined_units": 120}
```

**Gateway** (Express): endpoints map 1:1 to reducers plus read endpoints (`GET /recalls/:id/status`). Holds a stored SpacetimeDB token per organization so each agent acts under its own identity.

## 10. Web app screens

**`/command` (command center)**
- React Flow graph: factory → warehouses → stores, ingredient lots on the left. Nodes recolor live via subscriptions: gray (unaffected), amber (affected / awaiting), green (verified), red (exception / unknown / escalated).
- Header counters: affected locations, verified, awaiting, exceptions; location coverage and unit coverage.
- Status table: one row per affected location with status, units, last agent message.
- Live audit feed (right side) showing agent actions as they commit. This proves real agents are working.
- "Final report" panel: verified, sold before recall, lost in transit, unaccounted, unknown, escalated.
- Button "Start recall (fallback)" that triggers the same flow without ASI:One, in case Agentverse is down.

**`/store/[id]` (store terminal)**
- Inventory table per lot (available / quarantined).
- Simulated POS: scan/select lot + qty → "Sell". Quarantined lot shows a red **"Sale blocked: lot BAR-100 under recall REC-001"**.
- For MANUAL stores: "Confirm quarantine" button for open tasks.

## 11. Team split and aggressive schedule

### Ownership (no overlap)

Each person owns specific folders and edits only those. Everyone codes against `shared/contracts/` and mocks until the real piece lands, so nobody waits on anybody.

| Person | Owns (only they edit) | Builds against until integration |
| --- | --- | --- |
| **Atharva**: database and backend | `spacetimedb/` (except `trace.ts`, `reconcile.ts`), `shared/contracts/` | Fixtures |
| **Sarvesh**: agents and gateway | `agents/`, `gateway/` | Gateway's own mock responses |
| **Renuka**: web app | `web/` | `web/lib/data.ts` mock reading fixtures |
| **Prathamesh**: trace logic, data, tests, demo | `spacetimedb/src/trace.ts`, `spacetimedb/src/reconcile.ts`, `fixtures/`, `scripts/`, `tests/` | Fixtures in plain unit tests |

`trace.ts` and `reconcile.ts` are **pure functions** (input: arrays of rows, output: affected lots/locations and per-location numbers). Prathamesh writes and tests them; Atharva only calls them from `trace_recall`. That is the only shared touchpoint inside `spacetimedb/`.

### Per-person tasks

**Atharva (database and backend)**
- Fri 7:15–8:15 PM: build and commit the section 0 base template.
- Fri night: all section 5 tables, `seed_fixtures`, `record_sale` (with quarantine rejection), `report_recall_signal`, `authorize_recall`, `trace_recall` (calling Prathamesh's `trace.ts`), `assign_containment_tasks`.
- Sat morning: `claim_task`, `quarantine_lot` (idempotent), identity and role checks on every reducer, audit events.
- Sat midday: `check_task_timeouts` scheduled reducer, `close_recall`, generate client bindings for Renuka.

**Sarvesh (agents and gateway)**
- While template is built: create Agentverse account and API key, get a hello-world uAgent with the chat protocol answering in ASI:One. This is the riskiest integration, so prove it first.
- Fri night: coordinator and retailer agents exchanging `QUARANTINE_REQUEST` / `QUARANTINE_RESULT` against the mock gateway; Claude call that extracts `{root_lot, reason}`.
- Sat morning: swap the gateway mocks for real SpacetimeDB reducer calls, one identity per organization.
- Sat afternoon: kill-agent scenario end to end, coordinator report drafted from committed facts, cached Claude outputs for the demo.

**Renuka (web app)**
- While template is built: React Flow prototype of the supply-chain graph with the section 6 network.
- Fri night: full `/command` UI on mock data: graph with status colors, counters, status table, audit feed, report panel, fallback "Start recall" button.
- Sat morning: full `/store/[id]` UI: inventory table, POS with the "Sale blocked" state, manual "Confirm quarantine" button.
- Sat midday: replace the mock in `web/lib/data.ts` with SpacetimeDB subscriptions using Atharva's generated bindings. UI components should not change.

**Prathamesh (trace, data, tests, demo)**
- While template is built: write `fixtures/*.json` from section 6 and hand them to Atharva for the template commit.
- Fri night: `trace.ts` (BFS over lot edges then shipments) and `reconcile.ts` (expected vs reported, unaccounted units) with unit tests proving: BAR-100 and BAR-101 included, BAR-102 and Store F excluded, Store D shows 15 unaccounted.
- Sat morning: `scripts/seed.ts`, `scripts/reset.ts`, `scripts/demo-scenario.ts` (runs the section 12 flow automatically); end-to-end test.
- Sat afternoon onward: Devpost write-up, sponsor-by-sponsor descriptions, demo video shot list. Apify Actor only after Sat 7 PM if everything else is done.

### Schedule (Pacific time)

| By | Milestone | Acceptance test |
| --- | --- | --- |
| Fri 8:15 PM | **Base template committed**, everyone on their branch | Every app starts with its own `npm run dev`; fixtures load in the mocks |
| Fri 1:00 AM | Each part works alone on mocks | Trace tests pass; UI shows full flow on mock data; agents talk via mock gateway; reducers run locally |
| Sat 10:00 AM | **Integration 1:** real database behind the UI | Trace of PEANUT-009 shows correct stores live on the graph |
| Sat 1:00 PM | **Integration 2:** full chain via fallback button, no agents | Store A sale of BAR-100 blocked after quarantine; Store F sale of BAR-102 works |
| Sat 4:00 PM | **Integration 3:** agents and ASI:One drive the chain | Kill Store B agent → TIMED_OUT → ESCALATED → INVENTORY_UNKNOWN in report |
| Sat 7:00 PM | **Feature-complete** | Section 12 demo runs 3 times in a row after `scripts/reset.ts` with no manual fixes |
| Sat night | Polish, rehearse, record video draft, Devpost draft | Stretch: Apify Actor |
| Sun 5:00 AM | Feature freeze | — |
| Sun 8:00 AM | Final video and Devpost submitted | Before 9 AM deadline |

### Git rules

- Branch per person; merge to `main` at every integration milestone, not just at the end.
- Pull `main` before each integration and fix your own conflicts in your own folders.
- Small commits. Never edit another person's folder; ask in the team chat.
- If a contract needs to change, Atharva makes the change on `main` and everyone pulls.

## 12. Demo script (3 minutes)

| Time | Action |
| --- | --- |
| 0:00 | Show graph. "Two different bars share one peanut lot." |
| 0:25 | In ASI:One: "Start an investigation for contaminated ingredient PEANUT-009 and contain it." |
| 0:55 | Graph lights up: BAR-100, BAR-101, Stores A–E turn amber; Store F stays gray. Audit feed shows agents working; Store A turns green |
| 1:25 | Store A terminal: try to sell BAR-100 → **Sale blocked**. Sell BAR-102 at Store F → works |
| 1:55 | Store B agent was killed (terminal visible): task times out, escalates, Store B goes red "INVENTORY_UNKNOWN". Store D shows 15 unaccounted units |
| 2:25 | Final report: verified vs sold vs unaccounted vs unknown. "We don't claim containment we can't prove." |

## 13. Demo safety

- Everything runs locally on one laptop (local SpacetimeDB). Venue Wi-Fi is unreliable; keep a phone hotspot for ASI:One/Agentverse and Claude calls.
- Fallback button runs the identical flow if ASI:One or Agentverse fails.
- Cache the coordinator's Claude outputs for the demo scenario so a slow API call can't stall the demo.
- `scripts/reset.ts` restores the seeded state in one command between rehearsals.

## 14. Sponsor tracks to submit to

Fetch.ai (Best Use), SpacetimeDB (most impressive use), Anthropic, Microsoft Built for the Real World, Cal Hacks People-First Social Impact, Most Technically Advanced. Apify only if the stretch Actor ships. Describe each sponsor's role explicitly in the Devpost write-up.