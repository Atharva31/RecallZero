// Module entry. Re-exports the schema and every reducer.
// Reducers live in per-domain files and are re-exported here; helpers stay unexported.

import spacetimedb from './schema';
import { loadFixtures } from './fixtures';
import { ensureTimeoutTimer } from './tasks';

export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  // The publisher becomes admin (seed_fixtures, dev-only reducers).
  ctx.db.config.insert({ id: 0, admin: ctx.sender, nextRecallNo: 1, nextTaskNo: 1 });
  loadFixtures(ctx);
  ensureTimeoutTimer(ctx);
});

export const ping = spacetimedb.reducer(ctx => {
  console.info(`ping from ${ctx.sender.toHexString()} at ${ctx.timestamp.toISOString()}`);
});

export { claimOrgIdentity } from './permissions';
export { seedFixtures } from './fixtures';
export { recordSale } from './inventory';
export {
  reportRecallSignal,
  authorizeRecall,
  traceRecall,
  assignContainmentTasks,
  recordDiscrepancy,
  setDisposition,
  closeRecall,
} from './recalls';
export { claimTask, quarantineLot, checkTaskTimeouts } from './tasks';
