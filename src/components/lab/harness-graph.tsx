"use client";
// SVG map of the harness. In "live" mode, edges a function call travelled stay lit and the
// current call animates (a pulse runs along its path); untouched parts stay dim, so a tester
// sees exactly what ran and what didn't.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { EDGES, LAYERS, NODE_H, NODE_W, NODES, type EdgeId, type HarnessNode, type NodeId } from "./harness-spec";

const TOP = 34;
const WIDTH = 1230;
const HEIGHT = TOP + 530;

const byId = new Map(NODES.map((n) => [n.id, n]));

function edgePath(id: EdgeId): string {
  const [a, b] = id.split(">") as [NodeId, NodeId];
  const s = byId.get(a)!;
  const t = byId.get(b)!;
  const sy = TOP + s.y;
  const ty = TOP + t.y;
  if (s.x === t.x) {
    const x = s.x + NODE_W / 2;
    const down = ty > sy;
    const y1 = down ? sy + NODE_H : sy;
    const y2 = down ? ty : ty + NODE_H;
    return `M ${x} ${y1} L ${x} ${y2}`;
  }
  const forward = t.x > s.x;
  const x1 = forward ? s.x + NODE_W : s.x;
  const x2 = forward ? t.x : t.x + NODE_W;
  const y1 = sy + NODE_H / 2;
  const y2 = ty + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + (forward ? dx : -dx)} ${y1}, ${x2 - (forward ? dx : -dx)} ${y2}, ${x2} ${y2}`;
}

const LAYER_TONE: Record<HarnessNode["layer"], string> = {
  trigger: "var(--qm-appointment)",
  harness: "var(--qm-consult)",
  models: "var(--qm-followup)",
  tools: "var(--qm-urgent)",
  core: "var(--qm-good)",
};

export function HarnessGraph({
  mode,
  visited = new Set(),
  active = new Set(),
  selected,
  onSelect,
  badges = {},
  className,
}: {
  mode: "explore" | "live";
  visited?: Set<EdgeId>;
  active?: Set<EdgeId>;
  selected?: NodeId | null;
  onSelect?: (id: NodeId) => void;
  badges?: Partial<Record<NodeId, { text: string; tone?: "good" | "warn" | "bad" | "muted" }>>;
  className?: string;
}) {
  const [hover, setHover] = useState<NodeId | null>(null);
  const paths = useMemo(() => new Map(EDGES.map((e) => [e, edgePath(e)])), []);
  const touchedNodes = useMemo(() => {
    const s = new Set<NodeId>();
    for (const e of [...visited, ...active]) e.split(">").forEach((n) => s.add(n as NodeId));
    return s;
  }, [visited, active]);
  const activeNodes = useMemo(() => {
    const s = new Set<NodeId>();
    for (const e of active) e.split(">").forEach((n) => s.add(n as NodeId));
    return s;
  }, [active]);
  const anyActivity = visited.size > 0 || active.size > 0;
  const focus = hover ?? selected ?? null;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={cn("h-auto w-full select-none", className)} role="img" aria-label="Agent harness graph">
      <defs>
        <marker id="qm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/* Layer captions + column bands */}
      {LAYERS.map((l) => (
        <g key={l.id}>
          <rect x={l.x - 8} y={TOP - 8} width={NODE_W + 16} height={HEIGHT - TOP} rx={14} className="fill-foreground/[0.025]" />
          <text x={l.x} y={18} className="fill-muted-foreground text-[12px] font-semibold tracking-wider uppercase">
            {l.label}
          </text>
        </g>
      ))}

      {/* Edges */}
      {EDGES.map((e) => {
        const isActive = active.has(e);
        const isVisited = visited.has(e);
        const [a, b] = e.split(">");
        const related = focus !== null && (a === focus || b === focus);
        const dim = mode === "live" ? anyActivity && !isActive && !isVisited : focus !== null && !related;
        return (
          <g key={e} className={cn(isActive ? "text-primary" : isVisited ? "text-primary/70" : related ? "text-foreground/60" : "text-foreground/25")}>
            <path
              d={paths.get(e)}
              fill="none"
              stroke="currentColor"
              strokeWidth={isActive ? 3 : isVisited || related ? 2 : 1.4}
              markerEnd="url(#qm-arrow)"
              className={cn("transition-opacity duration-500", dim && "opacity-25", isActive && "qm-flow")}
              strokeDasharray={isActive ? "8 6" : undefined}
            />
            {isActive && (
              <circle r={5} className="fill-primary">
                <animateMotion dur="1.1s" repeatCount="indefinite" path={paths.get(e)} />
              </circle>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {NODES.map((n) => {
        const isActive = activeNodes.has(n.id);
        const touched = touchedNodes.has(n.id);
        const dim = mode === "live" && anyActivity && !touched;
        const isSelected = selected === n.id;
        const badge = badges[n.id];
        return (
          <g
            key={n.id}
            transform={`translate(${n.x} ${TOP + n.y})`}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(n.id)}
            className={cn("transition-opacity duration-500", onSelect && "cursor-pointer", dim && "opacity-35")}
          >
            {isActive && <rect x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={16} className="qm-node-pulse fill-primary/15" />}
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={12}
              className={cn(
                "stroke-[1.5] transition-colors",
                isActive ? "fill-primary stroke-primary" : touched ? "fill-card stroke-primary" : isSelected ? "fill-card stroke-foreground" : "fill-card stroke-border",
              )}
            />
            <rect x={0} y={10} width={4} height={NODE_H - 20} rx={2} style={{ fill: LAYER_TONE[n.layer] }} />
            <text x={16} y={24} className={cn("text-[14px] font-semibold", isActive ? "fill-primary-foreground" : "fill-foreground")}>
              {n.title}
            </text>
            <text x={16} y={43} className={cn("text-[11.5px]", isActive ? "fill-primary-foreground/85" : "fill-muted-foreground")}>
              {n.subtitle}
            </text>
            {badge && (
              <g transform={`translate(${NODE_W - 8} -9)`}>
                <rect
                  x={-(badge.text.length * 6.4 + 14)}
                  width={badge.text.length * 6.4 + 14}
                  height={18}
                  rx={9}
                  className={cn(
                    badge.tone === "good" ? "fill-qm-good" : badge.tone === "warn" ? "fill-qm-urgent" : badge.tone === "bad" ? "fill-qm-emergency" : "fill-foreground/70",
                  )}
                />
                <text x={-7} y={12.5} textAnchor="end" className="fill-white font-mono text-[10.5px] font-semibold">
                  {badge.text}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
