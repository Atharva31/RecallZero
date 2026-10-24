"use client";

// Command center (PLAN.md section 10). Owner: Renuka.
// TODO: React Flow graph, header counters, status table, audit feed, report panel, fallback button.

import { useData } from "@/lib/data";

export default function CommandPage() {
  const data = useData();
  return (
    <main className="p-8 space-y-2">
      <h1 className="text-2xl font-semibold">Command center</h1>
      <p className="text-sm opacity-70">
        Mock data loaded: {data.locations.length} locations, {data.lots.length} lots, {data.shipments.length} shipments,{" "}
        {data.recalls.length} recalls.
      </p>
    </main>
  );
}
