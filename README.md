# RecallZero

Autonomous recall-execution network (Cal Hacks 13). Full plan: [PLAN.md](PLAN.md).

## Layout and owners

| Folder | What | Owner |
| --- | --- | --- |
| `shared/contracts/` | Frozen types: tables, reducers, gateway, agent messages | Atharva (ask before changing) |
| `spacetimedb/` | SpacetimeDB TypeScript module (except `src/trace.ts`, `src/reconcile.ts`) | Atharva |
| `spacetimedb/src/trace.ts`, `reconcile.ts` | Pure trace / reconciliation functions | Prathamesh |
| `gateway/` | Express gateway for agents (mock mode now) | Sarvesh |
| `agents/` | Coordinator + retailer uAgents (Python) | Sarvesh |
| `web/` | Next.js command center + store terminal (mock data now) | Renuka |
| `fixtures/`, `scripts/`, `tests/` | Seed data, demo scripts, tests | Prathamesh |

## One-time setup

```bash
cp .env.example .env                                  # fill in API keys
curl -sSf https://install.spacetimedb.com | sh        # SpacetimeDB CLI 2.13 (then make sure ~/.local/bin is on PATH)
(cd spacetimedb && npm install)
(cd gateway && npm install)
(cd web && npm install)
(cd agents && npm run setup)                          # Python venv + uagents
```

## Run each part

| Part | Command | URL / notes |
| --- | --- | --- |
| SpacetimeDB server | `spacetime start` | ws://localhost:3000 |
| Module (publish) | `cd spacetimedb && npm run dev` | publishes `recallzero` to local; `npm run publish:reset` wipes data |
| Module smoke test | `spacetime call recallzero ping --server local && spacetime logs recallzero --server local -n 5` | |
| Client bindings | `cd spacetimedb && npm run generate` | writes `web/lib/module_bindings/` |
| Gateway | `cd gateway && npm run dev` | http://localhost:4000/health (mock mode) |
| Web | `cd web && npm run dev` | http://localhost:3001/command, http://localhost:3001/store/STORE-A (3000 is SpacetimeDB) |
| Coordinator agent | `cd agents && npm run dev:coordinator` | port 8001, logs its address |
| Retailer agents | `cd agents && npm run dev:store-a` / `npm run dev:store-b` | ports 8002 / 8003 |

## Real stack (SpacetimeDB behind everything)

```bash
spacetime start                                                    # terminal 1
(cd spacetimedb && npm run publish:reset)                          # fresh DB, fixtures loaded by init
GATEWAY_MODE=spacetimedb npm --prefix gateway run dev              # terminal 2
echo NEXT_PUBLIC_DATA_SOURCE=spacetimedb > web/.env.local && npm --prefix web run dev   # terminal 3
(cd agents && npm run dev:coordinator)   # terminal 4; and dev:store-a / dev:store-b
spacetime call recallzero seed_fixtures --server local             # reset between rehearsals
```

Who writes what:
- **Identities:** the gateway holds one SpacetimeDB identity per org (tokens in `gateway/.tokens/`) and binds it with `claim_org_identity`, re-claiming automatically after `seed_fixtures` clears bindings. Reducers check `ctx.sender`, never an org argument.
- **Web app:** reads SpacetimeDB directly through an anonymous, read-only subscription, and sends every write to the gateway: "Start recall (fallback)" as `ORG-ACME`, POS sales and "Confirm quarantine" as the store's own org. The browser never holds an org identity.
- **Coordinator:** adopts any `CONTAINING` recall it did not start (`GET /recalls`), so the fallback button still dispatches the retailer agents.
- **CLI:** the publisher's CLI identity is the admin (`seed_fixtures`). Don't `claim_org_identity` orgs from the CLI while the gateway runs; reseed if you did.

## Mock flow (works today, no database needed)

```bash
G=localhost:4000
curl -s -H 'X-Org-Id: ORG-ACME' -H 'Content-Type: application/json' -X POST $G/recalls -d '{"rootLotId":"PEANUT-009","reason":"Salmonella"}'
curl -s -H 'X-Org-Id: ORG-ACME' -X POST $G/recalls/REC-001/authorize
curl -s -H 'X-Org-Id: ORG-ACME' -X POST $G/recalls/REC-001/trace
curl -s -H 'X-Org-Id: ORG-ACME' -X POST $G/recalls/REC-001/assign
curl -s -H 'X-Org-Id: ORG-STORE-A' -X POST $G/tasks/T-1/claim
curl -s -H 'X-Org-Id: ORG-STORE-A' -X POST $G/tasks/T-1/quarantine
curl -s -H 'X-Org-Id: ORG-STORE-A' -H 'Content-Type: application/json' -X POST $G/sales -d '{"locationId":"STORE-A","lotId":"BAR-100","qty":1}'
# -> 409 LOT_QUARANTINED "Sale blocked: lot BAR-100 under recall REC-001"
curl -s $G/recalls/REC-001/status
# Store B (T-2) is never claimed: after 3 x 20 s lease windows it is ESCALATED and STORE-B becomes INVENTORY_UNKNOWN.
```

## Conventions

- camelCase fields everywhere in TS/JSON (matches generated SpacetimeDB bindings); agent-to-agent messages use the snake_case schema in `shared/contracts/messages.json`.
- Enum columns are strings in SpacetimeDB; valid values are the lists in `shared/contracts/tables.ts`.
- Reducer errors are `"CODE: message"` (see `ERROR_CODES` in `shared/contracts/reducers.ts`); the gateway returns `{ ok: false, error: { code, message } }`.
- Gateway caller identity: header `X-Org-Id` (coordinator = `ORG-ACME`, retailers = `ORG-STORE-A` / `ORG-STORE-B`).
- Branches: `atharva/db`, `sarvesh/agents`, `renuka/web`, `prathamesh/trace`. Merge to `main` at each integration milestone.
