// End-to-end: the section 12 demo against the real stack (SpacetimeDB + gateway in spacetimedb mode).
// Skipped when the stack is not running or agents are up. Takes ~70 s per run (Store B escalation).
// E2E_RUNS=3 repeats it back to back, the Sat 7 PM feature-complete bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../scripts/demo-scenario.ts';
import { gatewayHealth, portOpen, serverOnline } from '../../scripts/lib.ts';

const runs = Number(process.env.E2E_RUNS ?? 1);
const health = await gatewayHealth();
const agentsUp = (await Promise.all([8001, 8002, 8003].map(p => portOpen(p)))).some(Boolean);
const skip =
  !serverOnline() ? 'SpacetimeDB not running (spacetime start)'
  : !health ? 'gateway not running'
  : health.spacetimedb !== 'connected' ? 'gateway not in GATEWAY_MODE=spacetimedb'
  : agentsUp ? 'agents are running (stop them, or use scripts/demo-scenario.ts --agents)'
  : false;

for (let i = 1; i <= runs; i++) {
  test(`demo scenario run ${i}/${runs}: reset → trace → contain → POS → escalate → report`, { skip, timeout: 180_000 }, async () => {
    const facts = await runScenario({ reset: true });
    assert.deepEqual([...facts.affectedLots].sort(), ['BAR-100', 'BAR-101']);
    assert.deepEqual(facts.verified.map(v => v.locationId).sort(), ['STORE-A', 'STORE-C', 'STORE-E']);
    assert.deepEqual(facts.unaccounted, [{ locationId: 'STORE-D', units: 15 }]);
    assert.ok(facts.unknown.some(u => u.locationId === 'STORE-B'));
  });
}
