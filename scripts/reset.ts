// Restore the seeded state between rehearsals (PLAN.md section 13), in one command.
//
//   node scripts/reset.ts          # seed_fixtures, then verify through the gateway
//   node scripts/reset.ts --hard   # republish with --delete-data first (schema change, or the
//                                  # CLI identity is not the module admin)
//
// Needs `spacetime start` and the gateway in GATEWAY_MODE=spacetimedb. Agents may keep running:
// the coordinator tells recalls apart by id + createdAt, so a fresh REC-001 is adopted again.

import type { InventoryBalance, Recall } from '../shared/contracts/tables.ts';
import { seed } from './seed.ts';
import { args, check, gatewayHealth, GATEWAY_URL, gwOk, info, red, seededBalances, step, waitFor } from './lib.ts';

export async function reset({ hard = false } = {}) {
  const health = await gatewayHealth();
  if (!health) throw new Error(`Gateway not reachable at ${GATEWAY_URL}. Start it: GATEWAY_MODE=spacetimedb npm --prefix gateway run dev`);
  if (health.spacetimedb !== 'connected') {
    throw new Error(`Gateway is in ${health.spacetimedb} mode; restart it with GATEWAY_MODE=spacetimedb`);
  }

  seed({ publish: hard });

  step('Verifying seeded state through the gateway');
  await waitFor(
    'the gateway to see an empty recalls table',
    async () => (await gwOk<{ recalls: Recall[] }>('GET', '/recalls')).recalls.length === 0,
    { timeoutMs: 15_000, intervalMs: 500 }
  );
  check(true, 'no recalls');

  for (const [locationId, expected] of seededBalances()) {
    const { balances } = await gwOk<{ balances: InventoryBalance[] }>('GET', `/locations/${locationId}/inventory`);
    const key = (b: InventoryBalance) => `${b.lotId}:${b.available}/${b.quarantined}/${b.sold}/${b.damaged}`;
    const got = balances.map(key).sort().join(' ');
    const want = expected.map(key).sort().join(' ');
    check(got === want, `${locationId}: ${expected.map(b => `${b.lotId} ${b.available} available`).join(', ')}`, { got, want });
  }
  info('Gateway re-binds org identities on its next write.');
}

if (import.meta.main) {
  try {
    await reset({ hard: args.has('--hard') });
    console.log('\nReset complete.');
  } catch (e) {
    console.error(red(`\n${(e as Error).message}`));
    process.exit(1);
  }
}
