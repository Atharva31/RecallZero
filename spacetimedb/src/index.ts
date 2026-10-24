// Module entry. Re-exports the schema and every reducer.
// Reducers live in per-domain files (manufacturing.ts, shipments.ts, inventory.ts,
// recalls.ts, tasks.ts, permissions.ts, audit.ts) and are re-exported here.

import spacetimedb from './schema';

export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  // The publisher becomes admin (seed_fixtures, dev-only reducers).
  ctx.db.config.insert({ id: 0, admin: ctx.sender, nextRecallNo: 1, nextTaskNo: 1 });
});

export const ping = spacetimedb.reducer(ctx => {
  console.info(`ping from ${ctx.sender.toHexString()} at ${ctx.timestamp.toISOString()}`);
});
