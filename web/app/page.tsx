"use client";

import Link from "next/link";

import { useData } from "@/lib/data";

export default function Home() {
  const data = useData();
  const stores = data.locations.filter((l) => l.type === "STORE");
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">RecallZero</h1>
        <p className="text-slate-400">Autonomous recall execution. We don&apos;t claim containment we can&apos;t prove.</p>
      </div>
      <Link
        href="/command"
        className="block rounded-xl border border-slate-800 bg-slate-900 p-5 hover:border-slate-600"
      >
        <div className="text-lg font-semibold">Command center →</div>
        <div className="text-sm text-slate-400">Supply-chain graph, containment status, live audit feed, final report.</div>
      </Link>
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Store terminals</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stores.map((s) => {
            const org = data.organizations.find((o) => o.id === s.orgId);
            return (
              <Link
                key={s.id}
                href={`/store/${s.id}`}
                className="rounded-xl border border-slate-800 bg-slate-900 p-4 hover:border-slate-600"
              >
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {org?.integrationLevel === "CONNECTED" ? "Agent-connected" : "Manual"}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
