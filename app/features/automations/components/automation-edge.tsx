"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { Unlink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

export type AutomationFlowEdgeData = Record<string, unknown> & {
  branchLabel?: string;
  onRemove: () => void;
};

export type AutomationFlowEdge = Edge<AutomationFlowEdgeData, "automation">;

export function AutomationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<AutomationFlowEdge>) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={path} style={style} />
      <path
        aria-hidden="true"
        className="fill-none stroke-transparent"
        d={path}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        pointerEvents="stroke"
        strokeWidth={20}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{ left: labelX, top: labelY, pointerEvents: "all" }}
        >
          {data?.branchLabel ? (
            <span className="rounded-full border bg-card px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground shadow-sm">
              {data.branchLabel}
            </span>
          ) : null}
          <Button
            aria-label="Remover conexão"
            className={cn(
              "pointer-events-none h-6 bg-card px-2 text-2xs opacity-0 shadow-sm transition-opacity",
              hovered && "pointer-events-auto opacity-100",
            )}
            onClick={(event) => {
              event.stopPropagation();
              data?.onRemove();
            }}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            size="xs"
            title="Remover esta conexão"
            type="button"
            variant="outline"
          >
            <Unlink size={11} /> Remover conexão
          </Button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
