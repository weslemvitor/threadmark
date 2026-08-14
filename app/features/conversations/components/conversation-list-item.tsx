import { BellOff, CheckCheck } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { formatRelativeTime } from "@/app/lib/format";
import type { ConversationSummary } from "@/app/lib/conversations";
import { cn } from "@/app/lib/utils";

export function ConversationAvatar({
  conversation,
}: {
  conversation: ConversationSummary;
}) {
  const initials = conversation.subject
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase("pt-BR");

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center border text-xs font-bold tracking-wide",
        conversation.scope === "direct"
          ? "rounded-full border-emerald-200 bg-emerald-50 text-emerald-700"
          : "rounded-xl border-primary/20 bg-primary/10 text-primary",
      )}
    >
      {initials || (conversation.scope === "group" ? "GR" : "PV")}
    </span>
  );
}

export function ConversationListItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      aria-pressed={selected}
      className={cn(
        "grid min-h-24 w-full grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border bg-card px-3 py-3 text-left text-foreground transition-colors hover:bg-primary/[0.035]",
        selected && "bg-primary/[0.075] shadow-[inset_3px_0_0_var(--primary)]",
      )}
      onClick={onSelect}
      size="unstyled"
      type="button"
      variant="unstyled"
    >
      <ConversationAvatar conversation={conversation} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {conversation.subject}
          </strong>
          <time className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(conversation.lastMessageAt)}
          </time>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span className="truncate">{conversation.client.name}</span>
          <em className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-semibold not-italic text-primary">
            {conversation.scope === "group" ? "Grupo" : "Privado"}
          </em>
        </span>
        <span className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {conversation.lastMessagePreview || "Anexo ou evento sem texto"}
        </span>
      </span>
      <span className="flex min-w-6 flex-col items-end gap-2">
        {conversation.pendingCount > 0 ? (
          <b className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
            {conversation.pendingCount}
          </b>
        ) : (
          <CheckCheck className="text-emerald-600" size={16} />
        )}
        {conversation.suggestionsMuted ? (
          <small className="inline-flex items-center gap-1 whitespace-nowrap text-2xs text-amber-700">
            <BellOff size={10} /> pausado
          </small>
        ) : conversation.ticketCount > 0 ? (
          <small className="whitespace-nowrap text-2xs text-muted-foreground">
            {conversation.ticketCount} tkt
          </small>
        ) : null}
      </span>
    </Button>
  );
}
