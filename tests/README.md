# Tests (owner: Prathamesh)

Trace, reconciliation, permissions, end-to-end. Must prove: BAR-100 and BAR-101 included,
BAR-102 and Store F excluded, Store D shows 15 unaccounted.

```bash
cd tests && npm test     # Node >= 23.6 (runs .ts natively, no install needed)
```

- `unit/trace.test.ts`: `traceDownstream` against fixtures + multi-level/cyclic graphs.
- `unit/reconcile.test.ts`: `reconcileLocation` per location (Store D = 10 lost in transit, 15 unaccounted).
- `fixtures.ts`: loads `fixtures/*.json` typed as the contract shapes.
