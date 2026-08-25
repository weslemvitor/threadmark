"use client";

import {
  BookOpenText,
  BellRing,
  CheckCircle2,
  Clock3,
  Flag,
  GitBranch,
  MessageSquareShare,
  NotebookPen,
  Pencil,
  RefreshCw,
  SquareKanban,
  Ticket,
  Trash2,
  UserCheck,
  UserRoundCheck,
  UsersRound,
  Webhook,
} from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import type {
  AutomationExecutionStepStatus,
  AutomationNodeCategory,
} from "../domain";

const icons: Record<string, ComponentType<{ size?: number }>> = {
  "bell-ring": BellRing,
  "book-open-text": BookOpenText,
  "circle-check": CheckCircle2,
  clock: Clock3,
  flag: Flag,
  "message-square-share": MessageSquareShare,
  "notebook-pen": NotebookPen,
  "refresh-cw": RefreshCw,
  split: GitBranch,
  "square-kanban": SquareKanban,
  ticket: Ticket,
  "user-check": UserCheck,
  "user-round-check": UserRoundCheck,
  "users-round": UsersRound,
  webhook: Webhook,
};

const categoryLabels: Record<AutomationNodeCategory, string> = {
  trigger: "Gatilho",
  flow_control: "Controle",
  internal_action: "Threadmark",
  connected_app: "App conectado",
};

export type AutomationFlowNodeData = Record<string, unknown> & {
  catalogId: string;
  title: string;
  description: string;
  icon: string;
  category: AutomationNodeCategory;
  accent: "violet" | "blue" | "amber" | "emerald";
  invalid: boolean;
  warning: boolean;
  configured: boolean;
  configurationSummary?: string | null;
  testStatus?: AutomationExecutionStepStatus;
  onEdit: () => void;
  onRemove: () => void;
};

export type AutomationFlowNode = Node<AutomationFlowNodeData, "automation">;

export function AutomationNode({ data, selected }: NodeProps<AutomationFlowNode>) {
  const Icon = icons[data.icon] ?? Ticket;
  const isTrigger = data.category === "trigger";
  const isCondition = data.catalogId === "flow.condition";
  const isApproval = data.catalogId === "flow.approval";

  return (
    <div
      className={cn(
        "group relative w-[250px] rounded-xl border bg-card p-3 text-foreground shadow-sm transition-[box-shadow,border-color]",
        selected && "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary),transparent_82%)]",
        data.invalid && "border-destructive/70",
        !data.invalid && data.warning && "border-amber-400/70",
        data.testStatus === "passed" && "border-emerald-500 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-emerald-500),transparent_84%)]",
        data.testStatus === "failed" && "border-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive),transparent_84%)]",
      )}
    >
      <div className="nodrag nopan pointer-events-none absolute -top-3 right-2 z-10 flex items-center gap-1 rounded-lg border bg-card p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <Button
          aria-label={`Ajustar ${data.title}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onEdit();
          }}
          size="icon-xs"
          title="Ajustar etapa"
          type="button"
          variant="ghost"
        >
          <Pencil size={13} />
        </Button>
        <Button
          aria-label={`Excluir ${data.title}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={(event) => {
            event.stopPropagation();
            data.onRemove();
          }}
          size="icon-xs"
          title="Excluir etapa"
          type="button"
          variant="ghost"
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {!isTrigger ? (
        <Handle
          className="!size-2.5 !border-2 !border-card !bg-primary"
          position={Position.Top}
          type="target"
        />
      ) : null}
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary",
            data.accent === "blue" && "bg-blue-50 text-blue-600",
            data.accent === "amber" && "bg-amber-50 text-amber-600",
            data.accent === "emerald" && "bg-emerald-50 text-emerald-600",
          )}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{data.title}</span>
          <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {data.description}
          </span>
        </div>
      </div>
      {data.configurationSummary ? (
        <div className="mt-2 rounded-md bg-muted/70 px-2 py-1.5 text-xs font-medium leading-snug text-foreground">
          {data.configurationSummary}
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2">
        <Badge className="font-normal" variant="secondary">
          {categoryLabels[data.category]}
        </Badge>
        {data.testStatus === "passed" ? (
          <span className="text-2xs font-semibold text-emerald-700">Teste aprovado</span>
        ) : data.testStatus === "failed" ? (
          <span className="text-2xs font-semibold text-destructive">Falhou no teste</span>
        ) : data.invalid ? (
          <span className="text-2xs font-semibold text-destructive">Requer ajuste</span>
        ) : data.configured ? (
          <span className="text-2xs font-semibold text-emerald-600">Configurado</span>
        ) : null}
      </div>
      {isCondition || isApproval ? (
        <>
          <Handle
            className="!size-2.5 !border-2 !border-card !bg-emerald-500"
            id={isApproval ? "approved" : "true"}
            position={Position.Bottom}
            style={{ left: "30%" }}
            type="source"
          />
          <Handle
            className="!size-2.5 !border-2 !border-card !bg-rose-500"
            id={isApproval ? "rejected" : "false"}
            position={Position.Bottom}
            style={{ left: "70%" }}
            type="source"
          />
        </>
      ) : (
        <Handle
          className="!size-2.5 !border-2 !border-card !bg-primary"
          position={Position.Bottom}
          type="source"
        />
      )}
    </div>
  );
}
