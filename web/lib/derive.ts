// Pure views over a Snapshot: counters, coverage, report, graph colors.
// Data-source agnostic, so they keep working when lib/data.ts switches to SpacetimeDB.

import type {
  AffectedLocation,
  AffectedLocationStatus,
  AuditEvent,
  ContainmentTask,
  Recall,
} from "../../shared/contracts/tables";
import type { Snapshot } from "./data";

/** The recall the UI focuses on: newest one that is not CLOSED, else the newest. */
export function activeRecall(s: Snapshot): Recall | null {
  const open = s.recalls.filter((r) => r.status !== "CLOSED");
  return open.at(-1) ?? s.recalls.at(-1) ?? null;
}

export interface Coverage {
  affected: number;
  verified: number;
  awaiting: number;
  exceptions: number;
  locationCoverage: number; // 0..1
  quarantinedUnits: number;
  knownUnsoldUnits: number;
  unitCoverage: number; // 0..1
}

/** PLAN.md section 7. Only VERIFIED_CONTAINED counts as contained. */
export function coverage(locs: AffectedLocation[]): Coverage {
  const verified = locs.filter((a) => a.status === "VERIFIED_CONTAINED").length;
  const awaiting = locs.filter((a) => a.status === "AWAITING_ACKNOWLEDGMENT").length;
  const quarantinedUnits = locs.reduce((n, a) => n + a.quarantinedUnits, 0);
  const knownUnsoldUnits = locs.reduce((n, a) => n + Math.max(0, a.expectedUnits - a.soldUnits - a.unaccountedUnits), 0);
  return {
    affected: locs.length,
    verified,
    awaiting,
    exceptions: locs.length - verified - awaiting,
    locationCoverage: locs.length ? verified / locs.length : 0,
    quarantinedUnits,
    knownUnsoldUnits,
    unitCoverage: knownUnsoldUnits ? quarantinedUnits / knownUnsoldUnits : 0,
  };
}

export interface RecallView {
  recall: Recall;
  affectedLotIds: string[];
  locations: AffectedLocation[];
  tasks: ContainmentTask[];
  audit: AuditEvent[];
  coverage: Coverage;
}

export function recallView(s: Snapshot, recall: Recall): RecallView {
  const locations = s.affectedLocations.filter((a) => a.recallId === recall.recallId);
  return {
    recall,
    affectedLotIds: s.affectedLots.filter((a) => a.recallId === recall.recallId).map((a) => a.lotId),
    locations,
    tasks: s.containmentTasks.filter((t) => t.recallId === recall.recallId),
    audit: s.auditEvents.filter((e) => e.recallId === recall.recallId),
    coverage: coverage(locations),
  };
}

export interface ReportLine {
  locationId: string;
  units?: number;
  note?: string;
}

/** Final report facts (PLAN.md section 10), from committed rows only. */
export function report(v: RecallView) {
  const escalated = v.tasks.filter((t) => t.state === "ESCALATED");
  return {
    verified: v.locations
      .filter((a) => a.status === "VERIFIED_CONTAINED")
      .map((a): ReportLine => ({ locationId: a.locationId, units: a.quarantinedUnits })),
    soldBeforeRecall: v.locations
      .filter((a) => a.soldUnits > 0)
      .map((a): ReportLine => ({ locationId: a.locationId, units: a.soldUnits })),
    lostInTransit: v.locations
      .filter((a) => a.lostInTransitUnits > 0)
      .map((a): ReportLine => ({ locationId: a.locationId, units: a.lostInTransitUnits })),
    unaccounted: v.locations
      .filter((a) => a.unaccountedUnits > 0)
      .map((a): ReportLine => ({ locationId: a.locationId, units: a.unaccountedUnits })),
    unknown: v.locations
      .filter((a) => a.status === "INVENTORY_UNKNOWN" || a.status === "AWAITING_ACKNOWLEDGMENT" || a.status === "ACTION_FAILED")
      .map((a): ReportLine => ({ locationId: a.locationId, note: a.status })),
    escalated: escalated.map((t): ReportLine => ({ locationId: t.locationId, note: `${t.taskId}, ${t.attempts} attempts` })),
  };
}

// ---------- Colors (PLAN.md section 10) ----------

export type Tone = "gray" | "amber" | "green" | "red";

export function statusTone(status: AffectedLocationStatus | undefined): Tone {
  switch (status) {
    case undefined:
      return "gray";
    case "VERIFIED_CONTAINED":
      return "green";
    case "AWAITING_ACKNOWLEDGMENT":
    case "PARTIALLY_CONTAINED":
      return "amber";
    default:
      return "red";
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  gray: "bg-slate-800 text-slate-300 ring-slate-600",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/60",
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/60",
  red: "bg-rose-500/15 text-rose-300 ring-rose-500/60",
};

export const TONE_HEX: Record<Tone, { border: string; bg: string; text: string }> = {
  gray: { border: "#475569", bg: "#1e293b", text: "#cbd5e1" },
  amber: { border: "#f59e0b", bg: "#3b2a0a", text: "#fcd34d" },
  green: { border: "#10b981", bg: "#06302a", text: "#6ee7b7" },
  red: { border: "#f43f5e", bg: "#3b0d19", text: "#fda4af" },
};

/** Latest audit event that mentions this location or one of its tasks. */
export function lastMessageFor(v: RecallView, locationId: string): AuditEvent | undefined {
  const taskIds = v.tasks.filter((t) => t.locationId === locationId).map((t) => t.taskId);
  const re = new RegExp(`\\b(${[locationId, ...taskIds].map((x) => x.replace(/[-]/g, "\\-")).join("|")})\\b`);
  for (let i = v.audit.length - 1; i >= 0; i--) if (re.test(v.audit[i].detail)) return v.audit[i];
  return undefined;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
