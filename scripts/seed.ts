// Load fixtures/ into the local database.
//
//   node scripts/seed.ts            # call seed_fixtures (wipes every table, reloads fixtures)
//   node scripts/seed.ts --publish  # first time / schema change: republish with --delete-data
//                                   # (init loads the fixtures; the CLI identity becomes admin)
//
// Then checks the row counts against fixtures/*.json via `spacetime sql`.

import {
  args,
  check,
  countRows,
  fixture,
  info,
  publishReset,
  red,
  seedFixtures,
  serverOnline,
  SERVER,
  DB_NAME,
  step,
} from './lib.ts';

const TABLES: [table: string, fixture: string][] = [
  ['organizations', 'organizations'],
  ['locations', 'locations'],
  ['products', 'products'],
  ['lots', 'lots'],
  ['lot_edges', 'lot_edges'],
  ['shipments', 'shipments'],
  ['shipment_lines', 'shipment_lines'],
  ['inventory_events', 'inventory_events'],
  ['inventory_balances', 'inventory_balances'],
];

export function seed({ publish = false } = {}) {
  if (!serverOnline()) throw new Error(`SpacetimeDB server "${SERVER}" is not reachable. Start it with: spacetime start`);

  if (publish) {
    step(`Republishing ${DB_NAME} with --delete-data (fixtures loaded by init)`);
    publishReset();
  } else {
    step(`Calling seed_fixtures on ${DB_NAME}`);
    seedFixtures();
  }

  step('Checking seeded row counts');
  for (const [table, name] of TABLES) {
    const expected = fixture<unknown[]>(name).length;
    const actual = countRows(table);
    check(actual === expected, `${table}: ${actual} rows`, { expected });
  }
  for (const table of ['recalls', 'affected_locations', 'containment_tasks']) {
    check(countRows(table) === 0, `${table}: empty`);
  }
  info('Org identities are unbound; the gateway re-claims them on its next call.');
}

if (import.meta.main) {
  try {
    seed({ publish: args.has('--publish') });
  } catch (e) {
    console.error(red(`\n${(e as Error).message}`));
    process.exit(1);
  }
}
