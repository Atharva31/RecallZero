// Read models built from committed rows (contract shapes). Shared by the mock and
// the SpacetimeDB backends so the coordinator sees identical status and report facts.

import type {
  AffectedLocation,
  ContainmentTask,
  Location,
  Organization,
  Recall,
} from '../../shared/contracts/tables.ts';
import type { Coverage, RecallStatus, ReportFacts, TaskWithTarget } from '../../shared/contracts/gateway.ts';

export function withTarget(t: ContainmentTask, locations: Location[], organizations: Organization[]): TaskWithTarget {
  const orgId = locations.find(l => l.id === t.locationId)?.orgId ?? '';
  const org = organizations.find(o => o.id === orgId);
  return { ...t, orgId, integrationLevel: org?.integrationLevel ?? 'MANUAL' };
}

export function coverage(locs: AffectedLocation[]): Coverage {
  const verified = locs.filter(a => a.status === 'VERIFIED_CONTAINED').length;
  const awaiting = locs.filter(a => a.status === 'AWAITING_ACKNOWLEDGMENT').length;
  const quarantinedUnits = locs.reduce((s, a) => s + a.quarantinedUnits, 0);
  const knownUnsoldUnits = locs.reduce((s, a) => s + Math.max(0, a.expectedUnits - a.soldUnits - a.unaccountedUnits), 0);
  return {
    affectedLocations: locs.length,
    verifiedLocations: verified,
    awaitingLocations: awaiting,
    exceptionLocations: locs.length - verified - awaiting,
    locationCoverage: locs.length ? verified / locs.length : 0,
    quarantinedUnits,
    knownUnsoldUnits,
    unitCoverage: knownUnsoldUnits ? quarantinedUnits / knownUnsoldUnits : 0,
  };
}

/**
 * Settled when every CONNECTED task is VERIFIED or ESCALATED (MANUAL stores answer
 * through the store terminal on their own time) and no CONNECTED location is still awaiting.
 */
export function recallStatus(
  recall: Recall,
  affectedLots: string[],
  affectedLocations: AffectedLocation[],
  tasks: TaskWithTarget[]
): RecallStatus {
  const levelOf = (locationId: string) => tasks.find(t => t.locationId === locationId)?.integrationLevel ?? 'MANUAL';
  const settled =
    tasks.length > 0 &&
    tasks.every(t => t.state === 'VERIFIED' || t.state === 'ESCALATED' || t.integrationLevel === 'MANUAL') &&
    affectedLocations.every(a => a.status !== 'AWAITING_ACKNOWLEDGMENT' || levelOf(a.locationId) === 'MANUAL');
  return { recall, affectedLots, affectedLocations, tasks, coverage: coverage(affectedLocations), settled };
}

export function reportFacts(s: RecallStatus, generatedAt: string): ReportFacts {
  const locs = s.affectedLocations;
  return {
    recallId: s.recall.recallId,
    rootLotId: s.recall.rootLotId,
    reason: s.recall.reason,
    affectedLots: s.affectedLots,
    coverage: s.coverage,
    verified: locs
      .filter(a => a.status === 'VERIFIED_CONTAINED')
      .map(a => ({ locationId: a.locationId, quarantinedUnits: a.quarantinedUnits })),
    soldBeforeRecall: locs.filter(a => a.soldUnits > 0).map(a => ({ locationId: a.locationId, units: a.soldUnits })),
    lostInTransit: locs
      .filter(a => a.lostInTransitUnits > 0)
      .map(a => ({ locationId: a.locationId, units: a.lostInTransitUnits })),
    unaccounted: locs.filter(a => a.unaccountedUnits > 0).map(a => ({ locationId: a.locationId, units: a.unaccountedUnits })),
    unknown: locs
      .filter(a => a.status === 'INVENTORY_UNKNOWN' || a.status === 'AWAITING_ACKNOWLEDGMENT')
      .map(a => ({ locationId: a.locationId, status: a.status })),
    escalated: s.tasks
      .filter(t => t.state === 'ESCALATED')
      .map(t => ({ locationId: t.locationId, taskId: t.taskId, attempts: t.attempts })),
    generatedAt,
  };
}
