# Scripts (owner: Prathamesh)

Plain Node (>= 23.6, runs .ts natively), no install. Need `spacetime start` and, for `reset` and
`demo-scenario`, the gateway with `GATEWAY_MODE=spacetimedb`. `spacetime` is found on PATH,
in `$SPACETIME_BIN`, or in `~/.local/bin`.

| Command (from `scripts/`) | What it does |
| --- | --- |
| `npm run seed` | `seed_fixtures` (wipes every table, reloads `fixtures/`), then checks row counts |
| `node seed.ts --publish` | First time or schema change: republish with `--delete-data` (CLI identity becomes admin) |
| `npm run reset` | Between rehearsals: reseed, then verify through the gateway (no recalls, every balance matches section 6) |
| `npm run reset:hard` | Same, but republishes the module first |
| `npm run demo` | Section 12 flow with 2.5 s pauses between beats, so the command center can be watched |
| `npm run demo:fast` | Same flow, no pauses (~70 s, mostly Store B's three 20 s lease windows) |
| `npm run demo:agents` | Agents do the work: run the coordinator and Store A agent, kill the Store B agent first |

`demo-scenario.ts` resets first (`--no-reset` to skip), checks every beat, and exits non-zero on the
first failure, so it is also the end-to-end test (`tests/e2e/`). Without `--agents` it refuses to run
while agents are up, because they would answer Store B and there would be no escalation.
`--no-manual` leaves Stores C, D and E unconfirmed.

Agents can stay running across resets: the coordinator tells recalls apart by id + `createdAt`.
