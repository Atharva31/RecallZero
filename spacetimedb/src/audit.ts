// Every state change appends one audit_events row (PLAN.md section 8).

import type { Ctx } from './common';

export function audit(ctx: Ctx, recallId: string | null, actor: string, action: string, detail: string) {
  ctx.db.auditEvents.insert({
    id: 0n,
    recallId: recallId ?? undefined,
    actor,
    action,
    detail,
    at: ctx.timestamp,
  });
}
