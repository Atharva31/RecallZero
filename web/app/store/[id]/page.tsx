"use client";

// Store terminal (PLAN.md section 10). Owner: Renuka.
// TODO: POS "Sell" with the "Sale blocked" state, "Confirm quarantine" for MANUAL stores.

import { use } from "react";

import { useData } from "@/lib/data";

export default function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const data = useData();
  const location = data.locations.find((l) => l.id === id);
  const balances = data.inventoryBalances.filter((b) => b.locationId === id);

  if (!location) return <main className="p-8">Unknown store {id}</main>;
  return (
    <main className="p-8 space-y-4">
      <h1 className="text-2xl font-semibold">{location.name} terminal</h1>
      <table className="text-sm">
        <thead>
          <tr className="text-left">
            <th className="pr-6">Lot</th>
            <th className="pr-6">Available</th>
            <th className="pr-6">Quarantined</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.lotId}>
              <td className="pr-6">{b.lotId}</td>
              <td className="pr-6">{b.available}</td>
              <td className="pr-6">{b.quarantined}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
