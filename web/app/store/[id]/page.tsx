"use client";

// Store terminal (PLAN.md section 10). Owner: Renuka.
// Inventory per lot, simulated POS with the "Sale blocked" state, and the
// "Confirm quarantine" button for MANUAL stores.

import Link from "next/link";
import { use, useState } from "react";

import { getDataSource, useData } from "@/lib/data";
import { statusTone, TONE_CLASSES } from "@/lib/derive";

type SaleResult = { ok: true; message: string } | { ok: false; code: string; message: string };

export default function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const data = useData();
  const location = data.locations.find((l) => l.id === id);
  if (!data.locations.length) return <main className="p-8 text-slate-500">Loading…</main>;
  if (!location) {
    return (
      <main className="p-8">
        Unknown store {id}. <Link className="underline" href="/">Back</Link>
      </main>
    );
  }

  const org = data.organizations.find((o) => o.id === location.orgId);
  const manual = org?.integrationLevel !== "CONNECTED";
  const balances = data.inventoryBalances.filter((b) => b.locationId === id);
  const affected = data.affectedLocations.filter((a) => a.locationId === id);
  const tasks = data.containmentTasks.filter((t) => t.locationId === id);
  const openTasks = tasks.filter((t) => t.state !== "VERIFIED" && t.state !== "ESCALATED");
  const productName = (lotId: string) => {
    const sku = data.lots.find((l) => l.lotId === lotId)?.sku;
    return data.products.find((p) => p.sku === sku)?.name ?? lotId;
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">
            <Link href="/" className="hover:underline">RecallZero</Link> /{" "}
            <Link href="/command" className="hover:underline">Command center</Link> / Store terminal
          </p>
          <h1 className="text-2xl font-semibold">{location.name}</h1>
          <p className="text-sm text-slate-400">
            {org?.name} · <span className="font-mono">{location.id}</span> ·{" "}
            {manual ? "Manual store (staff confirms on this terminal)" : "Connected store (retailer agent acts automatically)"}
          </p>
        </div>
        <StoreSwitcher current={id} />
      </header>

      {affected.map((a) => (
        <div key={a.recallId} className={`rounded-xl px-4 py-3 ring-1 ${TONE_CLASSES[statusTone(a.status)]}`}>
          <div className="font-semibold">
            Recall {a.recallId}: {a.status.replaceAll("_", " ")}
          </div>
          <div className="text-sm opacity-80">
            {a.quarantinedUnits} units quarantined · {a.soldUnits} sold before recall
            {a.unaccountedUnits > 0 && ` · ${a.unaccountedUnits} units unaccounted`}
            {a.lostInTransitUnits > 0 && ` · ${a.lostInTransitUnits} lost in transit`}
          </div>
        </div>
      ))}

      {openTasks.length > 0 && (
        <section className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
          <h2 className="font-semibold text-amber-200">Quarantine requested</h2>
          {openTasks.map((t) => (
            <TaskRow key={t.taskId} taskId={t.taskId} lotIds={t.lotIds} state={t.state} manual={manual} />
          ))}
        </section>
      )}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <h2 className="border-b border-slate-800 px-4 py-2 text-sm font-semibold">Inventory</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2">Lot</th>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2 text-right">Available</th>
                <th className="px-4 py-2 text-right">Quarantined</th>
                <th className="px-4 py-2 text-right">Sold</th>
              </tr>
            </thead>
            <tbody>
              {balances.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-slate-500">No stock at this location.</td>
                </tr>
              )}
              {balances.map((b) => (
                <tr key={b.lotId} className={`border-b border-slate-800/60 last:border-0 ${b.quarantined ? "bg-rose-500/10" : ""}`}>
                  <td className="px-4 py-2 font-mono">
                    {b.lotId}
                    {b.quarantined > 0 && (
                      <span className="ml-2 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-sans font-semibold uppercase text-white">
                        Quarantined
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-300">{productName(b.lotId)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{b.available}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-rose-300">{b.quarantined}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{b.sold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <Pos key={id} locationId={id} lotIds={balances.map((b) => b.lotId)} productName={productName} />
      </div>
    </main>
  );
}

function TaskRow({ taskId, lotIds, state, manual }: { taskId: string; lotIds: string[]; state: string; manual: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await getDataSource().confirmQuarantine(taskId);
    if (!r.ok) setError(r.message);
    setBusy(false);
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <span className="font-mono">{taskId}</span>
      <span>Pull lots {lotIds.join(", ")} from the shelf</span>
      <span className="font-mono text-xs text-amber-300/80">{state}</span>
      {manual ? (
        <button
          className="ml-auto rounded-md bg-amber-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          onClick={confirm}
          disabled={busy}
        >
          Confirm quarantine
        </button>
      ) : (
        <span className="ml-auto text-xs text-slate-400">Handled by this store&apos;s retailer agent</span>
      )}
      {error && <span className="w-full text-rose-300">{error}</span>}
    </div>
  );
}

function Pos({ locationId, lotIds, productName }: { locationId: string; lotIds: string[]; productName: (l: string) => string }) {
  const [lot, setLot] = useState(lotIds[0] ?? "");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaleResult | null>(null);

  async function sell() {
    setBusy(true);
    const r = await getDataSource().recordSale(locationId, lot, qty);
    setResult(r.ok ? { ok: true, message: `Sold ${qty} × ${productName(lot)} (${lot})` } : r);
    setBusy(false);
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-semibold">Checkout (simulated POS)</h2>
      <label className="text-xs text-slate-400">
        Scan lot
        <select
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 font-mono text-sm text-slate-100"
          value={lot}
          onChange={(e) => {
            setLot(e.target.value);
            setResult(null);
          }}
        >
          {lotIds.map((l) => (
            <option key={l} value={l}>
              {l} · {productName(l)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-slate-400">
        Quantity
        <input
          type="number"
          min={1}
          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
        />
      </label>
      <button
        className="rounded-md bg-emerald-600 py-2.5 font-semibold hover:bg-emerald-500 disabled:opacity-50"
        onClick={sell}
        disabled={busy || !lot}
      >
        Sell
      </button>
      {result &&
        (result.ok ? (
          <div className="rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/50">
            {result.message}
          </div>
        ) : result.code === "LOT_QUARANTINED" ? (
          <div className="rounded-md bg-rose-600 px-3 py-3 text-center font-bold text-white shadow-lg shadow-rose-900/50">
            ⛔ {result.message}
          </div>
        ) : (
          <div className="rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/50">
            {result.message}
          </div>
        ))}
    </section>
  );
}

function StoreSwitcher({ current }: { current: string }) {
  const data = useData();
  const stores = data.locations.filter((l) => l.type === "STORE");
  return (
    <nav className="flex flex-wrap gap-1">
      {stores.map((s) => (
        <Link
          key={s.id}
          href={`/store/${s.id}`}
          className={`rounded-md px-2 py-1 text-xs ${s.id === current ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}
