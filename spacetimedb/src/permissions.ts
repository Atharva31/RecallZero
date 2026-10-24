// Caller identity and role checks. The caller is always ctx.sender resolved through
// organizations.identity; an org id argument is never proof of identity.
// One identity may be bound to several orgs (e.g. a dev web client), so checks pick
// the bound org that satisfies the role / ownership being asked for.

import { t } from 'spacetimedb/server';

import spacetimedb from './schema';
import { audit } from './audit';
import { fail, type Ctx } from './common';
import type { OrgType } from '../../shared/contracts/tables';

export function isAdmin(ctx: Ctx): boolean {
  const cfg = ctx.db.config.id.find(0);
  return !!cfg && cfg.admin.equals(ctx.sender);
}

export function requireAdmin(ctx: Ctx) {
  if (!isAdmin(ctx)) fail('UNAUTHORIZED', 'Only the database admin may do this');
}

function boundOrgs(ctx: Ctx) {
  return [...ctx.db.organizations.iter()].filter(o => o.identity?.equals(ctx.sender));
}

/** Returns the caller's org of one of `types`, or throws UNAUTHORIZED. */
export function requireRole(ctx: Ctx, ...types: OrgType[]) {
  const orgs = boundOrgs(ctx);
  const org = orgs.find(o => types.includes(o.type as OrgType));
  if (!org) {
    const who = orgs.length ? orgs.map(o => `${o.id} (${o.type})`).join(', ') : 'an unbound identity';
    fail('UNAUTHORIZED', `Requires ${types.join(' or ')}; caller is ${who}`);
  }
  return org;
}

/** Returns the caller's org that owns `locationId` (and has one of `types`), or throws. */
export function requireLocationOwner(ctx: Ctx, locationId: string, ...types: OrgType[]) {
  const location = ctx.db.locations.id.find(locationId);
  if (!location) fail('NOT_FOUND', `Location ${locationId} not found`);
  const org = boundOrgs(ctx).find(o => o.id === location.orgId);
  if (!org) fail('UNAUTHORIZED', `Caller does not own ${locationId} (owned by ${location.orgId})`);
  if (!types.includes(org.type as OrgType)) fail('UNAUTHORIZED', `${org.id} (${org.type}) may not do this`);
  return { org, location };
}

/**
 * Dev only. Binds ctx.sender to an org that is unbound or already bound to the caller.
 * The admin may rebind a bound org (e.g. after the gateway loses its stored token).
 */
export const claimOrgIdentity = spacetimedb.reducer({ orgId: t.string() }, (ctx, { orgId }) => {
  const org = ctx.db.organizations.id.find(orgId);
  if (!org) fail('NOT_FOUND', `Organization ${orgId} not found`);
  if (org.identity?.equals(ctx.sender)) return;
  if (org.identity && !isAdmin(ctx)) fail('UNAUTHORIZED', `${orgId} is already bound to another identity`);
  ctx.db.organizations.id.update({ ...org, identity: ctx.sender });
  audit(ctx, null, orgId, 'claim_org_identity', `${orgId} bound to ${ctx.sender.toHexString().slice(0, 12)}…`);
});
