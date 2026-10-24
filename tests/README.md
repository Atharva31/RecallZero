# Tests (owner: Prathamesh)

Trace, reconciliation, permissions, end-to-end. Must prove: BAR-100 and BAR-101 included,
BAR-102 and Store F excluded, Store D shows 15 unaccounted.

Node >= 23.6 (runs .ts natively, no install needed).

```bash
cd tests
npm test               # unit tests, no stack needed
npm run test:e2e       # section 12 demo against the real stack (~70 s)
npm run test:e2e:3x    # three runs back to back (feature-complete bar)
```

- `unit/trace.test.ts`: `traceDownstream` against fixtures + multi-level/cyclic graphs.
- `unit/reconcile.test.ts`: `reconcileLocation` per location (Store D = 10 lost in transit, 15 unaccounted).
- `e2e/demo.test.ts`: runs `scripts/demo-scenario.ts` (reset included). Needs `spacetime start` and the
  gateway with `GATEWAY_MODE=spacetimedb`; skipped when they are down or when agents are running.
  Includes the permission checks: an org cannot claim, quarantine or sell at another org's location,
  a retailer cannot close a recall, an unknown org is rejected, and rejected calls change nothing.
- `fixtures.ts`: loads `fixtures/*.json` typed as the contract shapes.
