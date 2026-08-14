import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  UserRound,
} from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import {
  getCategoryName,
  getClientName,
  getRequesterPresentation,
  getStoreName,
} from "@/app/lib/format";
import type { TicketSummary } from "@/app/lib/types";
import type { KanbanTab } from "@/app/lib/kanban-tabs";
import {
  getKanbanTicketTimeLabel,
  getKanbanTicketTimestamp,
} from "../domain/kanban-ticket";

export function KanbanCard({
  ticket,
  mode,
  columnId,
  selectable,
  selected,
  busy,
  onOpen,
  onToggle,
  onDragEnd,
  onDragStart,
}: {
  ticket: TicketSummary;
  mode: KanbanTab;
  columnId?: string;
  selectable: boolean;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDragEnd?: () => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const requester = getRequesterPresentation(ticket.requester);
  const archived = mode === "archived";
  const draggable = Boolean(onDragStart) && !selectable && !busy;

  return (
    <Button
      aria-label={
        selectable
          ? `${selected ? "Remover" : "Selecionar"} ticket #${ticket.number}`
          : undefined
      }
      aria-pressed={selectable ? selected : undefined}
      className={cn(
        "relative flex min-h-41 w-full cursor-pointer flex-col items-stretch justify-start whitespace-normal rounded-lg border border-border bg-card p-3 text-left text-card-foreground shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-primary/35 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-wait disabled:opacity-70",
        selectable && "pl-9",
        selected && "border-primary/70 bg-primary/5 ring-2 ring-primary/10",
      )}
      disabled={busy}
      draggable={draggable}
      onClick={selectable ? onToggle : onOpen}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      size="unstyled"
      type="button"
      variant="unstyled"
    >
      {selectable ? (
        <span
          className={cn(
            "absolute top-2.5 left-2.5 grid size-4.5 place-items-center rounded-[5px] border-2 border-muted-foreground/55 bg-background text-primary-foreground",
            selected && "border-primary bg-primary",
          )}
          aria-hidden="true"
        >
          {selected ? <Check size={13} /> : null}
        </span>
      ) : null}
      <span className="mb-2 flex w-full items-center">
        <b className="text-xs font-semibold text-primary">#{ticket.number}</b>
        <time
          className="ml-auto flex min-w-0 items-center justify-end gap-1 text-right text-xs leading-tight text-muted-foreground"
          dateTime={getKanbanTicketTimestamp(ticket, mode, columnId)}
        >
          <Clock3 size={12} />{" "}
          {getKanbanTicketTimeLabel(ticket, mode, columnId)}
        </time>
      </span>
      <strong className="line-clamp-2 text-sm leading-snug font-semibold text-foreground">
        {ticket.title}
      </strong>
      <p className="mt-1.5 truncate text-xs text-muted-foreground">
        {getClientName(ticket)}
        {getStoreName(ticket) ? ` · ${getStoreName(ticket)}` : ""}
      </p>
      {requester ? (
        <span
          className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs leading-tight text-muted-foreground"
          title={requester.compact}
        >
          <UserRound className="shrink-0 text-primary/80" size={12} />
          <span className="min-w-0 flex-1 basis-25 truncate font-medium">
            {requester.name}
          </span>
          {requester.phone && requester.phone !== requester.name ? (
            <small className="min-w-0 truncate text-xs text-muted-foreground/80">
              {requester.phone}
            </small>
          ) : null}
        </span>
      ) : null}
      <span className="mt-2.5 flex flex-wrap gap-1">
        {ticket.categories.slice(0, 2).map((category) => (
          <Badge className="h-5 px-2 text-xs font-medium not-italic" key={category.id} variant="secondary">
            {getCategoryName(category)}
          </Badge>
        ))}
        {ticket.needsReview ? (
          <Badge className="h-5 px-2 text-xs font-medium not-italic" variant="outline">
            Revisar
          </Badge>
        ) : null}
      </span>
      <span className="mt-auto flex items-center gap-1.5 border-t border-border/70 pt-2.5 text-xs font-medium text-muted-foreground">
        {archived ? (
          <>
            Arquivado, disponível para restauração
            <Archive className="ml-auto text-primary" size={14} />
          </>
        ) : ticket.status === "resolved" ? (
          <>
            Solução registrada
            <CheckCircle2 className="ml-auto text-primary" size={14} />
          </>
        ) : (
          <>
            Abrir contexto
            <ArrowRight className="ml-auto text-primary" size={14} />
          </>
        )}
      </span>
    </Button>
  );
}
