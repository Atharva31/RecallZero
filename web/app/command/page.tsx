"use client";

// Command center (PLAN.md section 10). Owner: Renuka.
// Graph, header counters, status table, live audit feed, final report, fallback "Start recall".

import Link from "next/link";
import { useState } from "react";

import { getDataSource, useData } from "@/lib/data";
import {
  activeRecall,
  lastMessageFor,
  pct,
  recallView,
  report,
  type RecallView,
  type ReportLine,
  statusTone,
  time,
  TONE_CLASSES,
} from "@/lib/derive";
import { useNow } from "@/lib/useNow";

import { SupplyGraph } from "./SupplyGraph";

export default function CommandPage() {
  const data = useData();
  const recall = activeRecall(data);
  const view = recall ? recallView(data, recall) : null;

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 lg:p-6">
      <Header view={view} />
      <Counters view={view} />
      <div className="grid flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="h-[480px] overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
            <SupplyGraph data={data} view={view} />
          </section>
          <StatusTable view={view} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <AuditFeed view={view} />
          <ReportPanel view={view} />
        </div>
      </div>
    </main>
  );
}

function Header({ view }: { view: RecallView | null }) {
  const data = useData();
  const ingredients = data.lots.filter((l) => l.kind === "INGREDIENT");
  const [lot, setLot] = useState("PEANUT-009");
  const [reason, setReason] = useState("Salmonella contamination");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recallOpen = view && view.recall.status !== "CLOSED";

  async function start() {
    setBusy(true);
    setError(null);
    const r = await getDataSource().startRecall(lot, reason);
    if (!r.ok) setError(r.message);
    setBusy(false);
  }

  return (
    <header className="flex flex-wrap items-center gap-4">
      <div className="mr-auto">
        <h1 className="text-xl font-semibold tracking-tight">
          <Link href="/">RecallZero</Link> <span className="text-slate-500">/ Command center</span>
        </h1>
        {view ? (
          <p className="text-sm text-slate-400">
            <span className="font-mono text-slate-200">{view.recall.recallId}</span> · root lot{" "}
            <span className="font-mono text-rose-300">{view.recall.rootLotId}</span> · {view.recall.reason} ·{" "}
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-200">{view.recall.status}</span>
          </p>
        ) : (
          <p className="text-sm text-slate-400">No active recall. Start one from ASI:One or with the fallback button.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2">
        <select
          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm"
          value={lot}
          onChange={(e) => setLot(e.target.value)}
          disabled={!!recallOpen}
        >
          {ingredients.map((l) => (
            <option key={l.lotId}>{l.lotId}</option>
          ))}
        </select>
        <input
          className="w-56 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={!!recallOpen}
        />
        <button
          className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={start}
          disabled={busy || !!recallOpen || !reason.trim()}
          title="Runs the same flow as the coordinator agent, without ASI:One"
        >
          Start recall (fallback)
        </button>
      </div>
      {error && <p className="w-full text-right text-sm text-rose-400">{error}</p>}
    </header>
  );
}

function Counters({ view }: { view: RecallView | null }) {
  const c = view?.coverage;
  const tiles: { label: string; value: string; sub?: string; tone: string }[] = [
    { label: "Affected locations", value: String(c?.affected ?? 0), tone: "text-slate-100" },
    { label: "Verified contained", value: String(c?.verified ?? 0), tone: "text-emerald-300" },
    { label: "Awaiting", value: String(c?.awaiting ?? 0), tone: "text-amber-300" },
    { label: "Exceptions / unknown", value: String(c?.exceptions ?? 0), tone: "text-rose-300" },
    {
      label: "Location coverage",
      value: pct(c?.locationCoverage ?? 0),
      sub: `${c?.verified ?? 0} of ${c?.affected ?? 0} locations`,
      tone: "text-slate-100",
    },
    {
      label: "Unit coverage",
      value: pct(c?.unitCoverage ?? 0),
      sub: `${c?.quarantinedUnits ?? 0} of ${c?.knownUnsoldUnits ?? 0} known unsold units`,
      tone: "text-slate-100",
    },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
          <div className={`text-2xl font-semibold tabular-nums ${t.tone}`}>{t.value}</div>
          {t.sub && <div className="text-xs text-slate-500">{t.sub}</div>}
        </div>
      ))}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status as Parameters<typeof statusTone>[0]);
  return (
    <span className={`inline-block rounded-md px-2 py-0.5 font-mono text-[11px] ring-1 ${TONE_CLASSES[tone]}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

function StatusTable({ view }: { view: RecallView | null }) {
  const data = useData();
  const now = useNow();
  if (!view || view.locations.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-500">
        Affected locations appear here once the recall is traced.
      </section>
    );
  }
  return (
    <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr className="border-b border-slate-800">
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Task</th>
            <th className="px-3 py-2 text-right">Received</th>
            <th className="px-3 py-2 text-right">Sold</th>
            <th className="px-3 py-2 text-right">Quarantined</th>
            <th className="px-3 py-2 text-right">Unaccounted</th>
            <th className="px-3 py-2 text-right">Lost in transit</th>
            <th className="px-3 py-2">Last agent message</th>
          </tr>
        </thead>
        <tbody>
          {view.locations.map((a) => {
            const loc = data.locations.find((l) => l.id === a.locationId);
            const org = data.organizations.find((o) => o.id === loc?.orgId);
            const task = view.tasks.find((t) => t.locationId === a.locationId);
            const msg = lastMessageFor(view, a.locationId);
            const leaseLeft =
              task?.leaseExpiresAt && now ? Math.max(0, Math.ceil((Date.parse(task.leaseExpiresAt) - now) / 1000)) : null;
            return (
              <tr key={a.locationId} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-2">
                  <Link href={`/store/${a.locationId}`} className="font-medium hover:underline">
                    {loc?.name ?? a.locationId}
                  </Link>
                  <div className="text-xs text-slate-500">{org?.integrationLevel === "CONNECTED" ? "Agent" : "Manual"}</div>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-300">
                  {task ? (
                    <>
                      {task.taskId} {task.state}
                      <div className="text-slate-500">
                        attempt {task.attempts}
                        {leaseLeft !== null && ` · lease ${leaseLeft}s`}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{a.expectedUnits}</td>
                <td className="px-3 py-2 text-right tabular-nums">{a.soldUnits}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{a.quarantinedUnits}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${a.unaccountedUnits ? "font-semibold text-rose-300" : ""}`}>
                  {a.unaccountedUnits}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${a.lostInTransitUnits ? "text-amber-300" : ""}`}>
                  {a.lostInTransitUnits}
                </td>
                <td className="max-w-xs px-3 py-2 text-xs text-slate-400">
                  {msg ? (
                    <>
                      <span className="text-slate-500">{time(msg.at)}</span> {msg.detail}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

const ACTOR_COLOR: Record<string, string> = {
  system: "text-sky-300",
  "ORG-ACME": "text-violet-300",
};

function AuditFeed({ view }: { view: RecallView | null }) {
  const events = view ? [...view.audit].reverse() : [];
  return (
    <section className="flex max-h-[480px] min-h-[240px] flex-col rounded-xl border border-slate-800 bg-slate-900">
      <h2 className="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-sm font-semibold">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        Live audit feed
      </h2>
      <ol className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-xs">
        {events.length === 0 && <li className="text-slate-500">Committed actions stream here.</li>}
        {events.map((e) => (
          <li key={e.id} className="border-l-2 border-slate-700 pl-2">
            <div className="flex gap-2 font-mono">
              <span className="text-slate-500">{time(e.at)}</span>
              <span className={ACTOR_COLOR[e.actor] ?? "text-emerald-300"}>{e.actor}</span>
              <span className="text-slate-400">{e.action}</span>
            </div>
            <div className="text-slate-300">{e.detail}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReportPanel({ view }: { view: RecallView | null }) {
  if (!view || view.locations.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-500">
        Final report is built from committed facts once containment starts.
      </section>
    );
  }
  const r = report(view);
  const sum = (xs: ReportLine[]) => xs.reduce((n, x) => n + (x.units ?? 0), 0);
  const groups: { title: string; lines: ReportLine[]; tone: string; total?: number }[] = [
    { title: "Verified contained", lines: r.verified, tone: "text-emerald-300", total: sum(r.verified) },
    { title: "Sold before recall", lines: r.soldBeforeRecall, tone: "text-slate-300", total: sum(r.soldBeforeRecall) },
    { title: "Lost in transit", lines: r.lostInTransit, tone: "text-amber-300", total: sum(r.lostInTransit) },
    { title: "Unaccounted", lines: r.unaccounted, tone: "text-rose-300", total: sum(r.unaccounted) },
    { title: "Unknown / unverified", lines: r.unknown, tone: "text-rose-300" },
    { title: "Escalated", lines: r.escalated, tone: "text-rose-300" },
  ];
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900">
      <h2 className="border-b border-slate-800 px-4 py-2 text-sm font-semibold">Final report · {view.recall.recallId}</h2>
      <div className="divide-y divide-slate-800 text-sm">
        {groups.map((g) => (
          <div key={g.title} className="px-4 py-2">
            <div className="flex justify-between">
              <span className={`font-medium ${g.tone}`}>{g.title}</span>
              <span className="tabular-nums text-slate-400">
                {g.total !== undefined ? `${g.total} units` : `${g.lines.length} locations`}
              </span>
            </div>
            {g.lines.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-slate-400">
                {g.lines.map((l) => (
                  <span key={l.locationId} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono">
                    {l.locationId}
                    {l.units !== undefined && ` · ${l.units}`}
                    {l.note && ` · ${l.note.replaceAll("_", " ")}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
        Only verified locations count as contained. Unknown and escalated stores are never assumed safe.
      </p>
    </section>
  );
}
