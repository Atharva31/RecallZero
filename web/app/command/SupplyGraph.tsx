"use client";

// Supply-chain graph: ingredient lots -> products -> factory -> warehouses -> stores.
// Node colors (PLAN.md section 10): gray unaffected, amber affected/awaiting,
// green verified, red exception/unknown/escalated.

import { Background, Handle, type Node, type NodeProps, Position, ReactFlow, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";

import type { Snapshot } from "@/lib/data";
import { type RecallView, statusTone, type Tone, TONE_HEX } from "@/lib/derive";

type RzNode = Node<{ title: string; subtitle: string; badge?: string; tone: Tone }, "rz">;

function RzNodeView({ data }: NodeProps<RzNode>) {
  const c = TONE_HEX[data.tone];
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg transition-colors duration-500"
      style={{ border: `2px solid ${c.border}`, background: c.bg, color: c.text, minWidth: 140 }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="font-semibold text-sm">{data.title}</div>
      <div className="opacity-80">{data.subtitle}</div>
      {data.badge && <div className="mt-1 font-mono text-[10px] uppercase tracking-wide">{data.badge}</div>}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { rz: RzNodeView };

const INGREDIENT_X = -320;
const PRODUCT_X = -20;

function spread(i: number, n: number, top = 40, bottom = 520) {
  return n <= 1 ? (top + bottom) / 2 : top + ((bottom - top) * i) / (n - 1);
}

export function SupplyGraph({ data, view }: { data: Snapshot; view: RecallView | null }) {
  const { nodes, edges } = useMemo(() => {
    const root = view?.recall.rootLotId;
    const contaminated = new Set([...(root ? [root] : []), ...(view?.affectedLotIds ?? [])]);
    const statusByLoc = new Map(view?.locations.map((a) => [a.locationId, a]) ?? []);
    const productName = new Map(data.products.map((p) => [p.sku, p.name]));

    const ingredients = data.lots.filter((l) => l.kind === "INGREDIENT");
    const finished = data.lots.filter((l) => l.kind === "FINISHED");
    const factory = data.locations.find((l) => l.type === "FACTORY");

    // Shipments carrying a contaminated lot, and the locations they leave from.
    const linesByShipment = new Map<string, string[]>();
    for (const sl of data.shipmentLines) linesByShipment.set(sl.shipmentId, [...(linesByShipment.get(sl.shipmentId) ?? []), sl.lotId]);
    const hot = (shipmentId: string) => (linesByShipment.get(shipmentId) ?? []).some((l) => contaminated.has(l));
    const inPath = new Set(data.shipments.filter((s) => hot(s.shipmentId)).flatMap((s) => [s.fromLocation, s.toLocation]));

    const nodes: RzNode[] = [
      ...ingredients.map((l, i): RzNode => ({
        id: l.lotId,
        type: "rz",
        position: { x: INGREDIENT_X, y: spread(i, ingredients.length) },
        data: {
          title: l.lotId,
          subtitle: `Ingredient · ${l.quantity} kg`,
          tone: l.lotId === root ? "red" : "gray",
          badge: l.lotId === root ? "contaminated" : undefined,
        },
      })),
      ...finished.map((l, i): RzNode => ({
        id: l.lotId,
        type: "rz",
        position: { x: PRODUCT_X, y: spread(i, finished.length, 140, 440) },
        data: {
          title: l.lotId,
          subtitle: productName.get(l.sku ?? "") ?? "Product",
          tone: contaminated.has(l.lotId) ? "amber" : "gray",
          badge: contaminated.has(l.lotId) ? "affected" : undefined,
        },
      })),
      ...data.locations.map((loc): RzNode => {
        const a = statusByLoc.get(loc.id);
        const org = data.organizations.find((o) => o.id === loc.orgId);
        const tone: Tone = a ? statusTone(a.status) : inPath.has(loc.id) && loc.type !== "STORE" ? "amber" : "gray";
        const stock = data.inventoryBalances
          .filter((b) => b.locationId === loc.id)
          .reduce((n, b) => n + b.available, 0);
        return {
          id: loc.id,
          type: "rz",
          position: { x: loc.x, y: loc.y },
          data: {
            title: loc.name,
            subtitle:
              loc.type === "STORE"
                ? `${org?.integrationLevel === "CONNECTED" ? "Agent" : "Manual"} · ${stock} on shelf`
                : loc.type.toLowerCase(),
            tone,
            badge: a ? a.status.replaceAll("_", " ") : undefined,
          },
        };
      }),
    ];

    const edgeStyle = (on: boolean) => ({
      stroke: on ? TONE_HEX.amber.border : "#475569",
      strokeWidth: on ? 2.5 : 1.5,
    });

    const edges: Edge[] = [
      ...data.lotEdges.map((e): Edge => {
        const on = contaminated.has(e.parentLotId) && contaminated.has(e.childLotId);
        return { id: `le-${e.parentLotId}-${e.childLotId}`, source: e.parentLotId, target: e.childLotId, animated: on, style: edgeStyle(on) };
      }),
      ...(factory
        ? finished.map((l): Edge => {
            const on = contaminated.has(l.lotId);
            return { id: `mf-${l.lotId}`, source: l.lotId, target: factory.id, animated: on, style: edgeStyle(on) };
          })
        : []),
      ...data.shipments.map((s): Edge => {
        const on = hot(s.shipmentId);
        return {
          id: s.shipmentId,
          source: s.fromLocation,
          target: s.toLocation,
          label: (linesByShipment.get(s.shipmentId) ?? []).join(", "),
          labelStyle: { fill: on ? "#fcd34d" : "#94a3b8", fontSize: 10 },
          labelBgStyle: { fill: "#0f172a" },
          animated: on,
          style: edgeStyle(on),
        };
      }),
    ];
    return { nodes, edges };
  }, [data, view]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background color="#1e293b" gap={24} />
    </ReactFlow>
  );
}
