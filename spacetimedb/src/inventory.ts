// Event-sourced stock: every change writes an inventory_events row and updates the
// inventory_balances row in the same reducer.

import { t } from 'spacetimedb/server';

import spacetimedb from './schema';
import { audit } from './audit';
import { fail, type Ctx } from './common';
import { requireLocationOwner } from './permissions';
import { refreshAffectedLocations } from './recalls';

export function findBalance(ctx: Ctx, lotId: string, locationId: string) {
  for (const b of ctx.db.inventoryBalances.byLotLocation.filter([lotId, locationId])) return b;
  return undefined;
}

export function recordEvent(
  ctx: Ctx,
  lotId: string,
  locationId: string,
  type: 'RECEIVED' | 'SOLD' | 'DAMAGED' | 'QUARANTINED' | 'ADJUSTED',
  qty: number,
  actor: string
) {
  ctx.db.inventoryEvents.insert({ id: 0n, lotId, locationId, type, qty, at: ctx.timestamp, actor });
}

/** The recall a lot is quarantined under at a location (for the POS message). */
function quarantiningRecall(ctx: Ctx, locationId: string, lotId: string): string {
  for (const task of ctx.db.containmentTasks.locationId.filter(locationId)) {
    if (task.lotIds.includes(lotId)) return task.recallId;
  }
  return 'unknown';
}

/** POS sale. Rejects quarantined lots (LOT_QUARANTINED) and overselling (INSUFFICIENT_STOCK). */
export const recordSale = spacetimedb.reducer(
  { locationId: t.string(), lotId: t.string(), qty: t.u32() },
  (ctx, { locationId, lotId, qty }) => {
    const { org } = requireLocationOwner(ctx, locationId, 'RETAILER');
    if (qty <= 0) fail('INVALID_ARGUMENT', 'qty must be positive');
    const b = findBalance(ctx, lotId, locationId);
    if (!b) fail('NOT_FOUND', `No stock of ${lotId} at ${locationId}`);
    if (b.quarantined > 0) {
      fail('LOT_QUARANTINED', `Sale blocked: lot ${lotId} under recall ${quarantiningRecall(ctx, locationId, lotId)}`);
    }
    if (b.available < qty) fail('INSUFFICIENT_STOCK', `Only ${b.available} of ${lotId} available at ${locationId}`);

    ctx.db.inventoryBalances.id.update({ ...b, available: b.available - qty, sold: b.sold + qty });
    recordEvent(ctx, lotId, locationId, 'SOLD', qty, org.id);
    refreshAffectedLocations(ctx, locationId);
    audit(ctx, null, org.id, 'record_sale', `${locationId} sold ${qty} × ${lotId}`);
  }
);
