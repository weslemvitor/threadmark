import { Check, FileText, TicketCheck } from "lucide-react";

import {
  AudioAttachment,
  InlineImageAttachment,
  isImageAttachment,
} from "@/app/components/shared";
import { Button } from "@/app/components/ui/button";
import { API_URL } from "@/app/lib/api";
import type {
  ConversationMessage,
  ConversationMessagesResponse,
  ConversationTriageState,
} from "@/app/lib/conversations";
import {
  formatBytes,
  formatMessageTime,
  formatPhoneNumber,
} from "@/app/lib/format";
import { cn } from "@/app/lib/utils";

const stateLabels: Record<ConversationTriageState, string> = {
  unreviewed: "Pendente",
  ticketed: "Em ticket",
  ignored: "Ignorada",
  context: "Contexto",
};

export function messageIsSelectable(message: ConversationMessage): boolean {
  return Boolean(message.id);
}

export function applyReactionUpdates(
  messages: ConversationMessage[],
  updates: ConversationMessagesResponse["reactionUpdates"],
): ConversationMessage[] {
  if (!updates.length) return messages;
  const reactionsByMessageId = new Map(
    updates.map((update) => [update.messageId, update.reactions]),
  );
  return messages.map((message) => {
    const reactions = reactionsByMessageId.get(message.id);
    return reactions === undefined ? message : { ...message, reactions };
  });
}

function AttachmentPreview({
  attachment,
}: {
  attachment: ConversationMessage["attachments"][number];
}) {
  if (attachment.kind === "audio") {
    return <AudioAttachment attachment={attachment} />;
  }

  if (isImageAttachment(attachment)) {
    return <InlineImageAttachment attachment={attachment} />;
  }

  const href =
    attachment.available && attachment.url
      ? attachment.url.startsWith("http")
        ? attachment.url
        : `${API_URL}${attachment.url}`
      : null;
  const content = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <FileText size={17} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate text-xs font-medium text-foreground">
          {attachment.fileName || "Documento"}
        </strong>
        <small className="mt-0.5 text-xs text-muted-foreground">
          {attachment.mimeType || attachment.kind}
          {attachment.sizeBytes
            ? ` · ${formatBytes(attachment.sizeBytes)}`
            : ""}
        </small>
      </span>
    </>
  );

  return href ? (
    <a
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 p-2 text-inherit no-underline transition-colors hover:border-primary/30"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <span className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 p-2 text-inherit opacity-60">
      {content}
    </span>
  );
}

function quotedMessagePreview(message: ConversationMessage): string {
  const reply = message.replyTo;
  if (!reply?.available) return "Mensagem citada não disponível no histórico";
  if (reply.text?.trim()) return reply.text.trim();
  if (reply.messageType?.toLowerCase().includes("image")) return "Imagem";
  if (reply.messageType?.toLowerCase().includes("document")) return "Documento";
  if (reply.messageType?.toLowerCase().includes("video")) return "Vídeo";
  if (reply.messageType?.toLowerCase().includes("audio")) return "Áudio";
  if (reply.messageType?.toLowerCase().includes("sticker")) return "Figurinha";
  return "Mensagem sem texto";
}

export function ConversationMessageBubble({
  message,
  selected,
  selectionLocked,
  onSelect,
  onOpenTicket,
}: {
  message: ConversationMessage;
  selected: boolean;
  selectionLocked: boolean;
  onSelect: (shiftKey: boolean) => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const selectable = messageIsSelectable(message) && !selectionLocked;
  const senderPhone = formatPhoneNumber(message.sender.phoneE164);
  const stateClassName: Record<ConversationTriageState, string> = {
    unreviewed: "bg-amber-100 text-amber-800",
    ticketed: "bg-primary/10 text-primary",
    ignored: "bg-muted text-muted-foreground",
    context: "bg-emerald-100 text-emerald-800",
  };

  return (
    <article
      className={cn(
        "group flex w-full items-start gap-2 pb-2.5",
        message.sender.isStaff && "justify-end",
      )}
      id={`conversation-message-${message.id}`}
    >
      <Button
        aria-label={
          selected ? "Remover mensagem da seleção" : "Selecionar mensagem"
        }
        aria-pressed={selected}
        className={cn(
          "mt-2 grid size-6 shrink-0 place-items-center rounded-full border border-border bg-card/90 text-primary-foreground opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 disabled:invisible",
          message.sender.isStaff && "order-2",
          selected && "border-primary bg-primary opacity-100",
        )}
        disabled={!selectable}
        onClick={(event) => onSelect(event.shiftKey)}
        size="unstyled"
        title={
          selectable
            ? "Selecionar · use Shift para escolher um intervalo"
            : undefined
        }
        type="button"
        variant="unstyled"
      >
        {selected ? <Check size={13} /> : null}
      </Button>
      <div
        className={cn(
          "relative min-w-44 max-w-[min(76%,690px)] rounded-[4px_12px_12px_12px] border border-border bg-card px-3 py-2 shadow-sm",
          message.sender.isStaff &&
            "order-1 rounded-[12px_4px_12px_12px] border-primary/20 bg-primary/10",
          selected && "border-primary/60 ring-3 ring-primary/10",
        )}
      >
        <header className="flex items-start gap-2">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <strong className="text-xs font-semibold text-primary">
              {message.sender.displayName ||
                (message.sender.isStaff ? "Equipe de suporte" : "Cliente")}
            </strong>
            {message.sender.isStaff ? (
              <em className="rounded bg-emerald-100 px-1 py-0.5 text-2xs font-bold not-italic text-emerald-800 uppercase">
                Equipe
              </em>
            ) : null}
            {senderPhone ? (
              <small className="text-xs text-muted-foreground">
                {senderPhone}
              </small>
            ) : null}
          </span>
          <time
            className="shrink-0 text-xs text-muted-foreground"
            dateTime={message.occurredAt}
          >
            {formatMessageTime(message.occurredAt)}
          </time>
        </header>
        {message.replyTo ? (
          <blockquote
            className={cn(
              "mt-2 min-w-0 max-w-full overflow-hidden rounded-r-lg border-l-3 border-primary bg-muted/80 px-2.5 py-2 text-muted-foreground",
              message.sender.isStaff && "bg-card/60",
            )}
          >
            <strong className="block truncate text-xs font-semibold text-primary">
              {message.replyTo.sender?.displayName || "Mensagem citada"}
            </strong>
            <span className="mt-1 line-clamp-3 block min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap text-xs leading-relaxed">
              {quotedMessagePreview(message)}
            </span>
          </blockquote>
        ) : null}
        {message.text ? (
          <p className="mt-2 mb-0.5 [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {message.text}
          </p>
        ) : null}
        {message.attachments.length ? (
          <div className="mt-2 grid gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentPreview attachment={attachment} key={attachment.id} />
            ))}
          </div>
        ) : null}
        {message.reactions.length ? (
          <div
            aria-label="Reações recebidas nesta mensagem"
            className="mt-2 flex max-w-full flex-wrap items-center gap-1.5"
            role="list"
          >
            {message.reactions.map((reaction) => {
              const reactorNames = reaction.reactors
                .map((reactor) => reactor.displayName)
                .join(", ");
              return (
                <span
                  aria-label={
                    reaction.count === 1
                      ? `Reação ${reaction.emoji} de ${reactorNames}`
                      : `${reaction.count} reações ${reaction.emoji} de ${reactorNames}`
                  }
                  className="inline-flex min-h-6 min-w-0 items-center justify-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-sm text-foreground shadow-sm"
                  key={reaction.emoji}
                  role="listitem"
                  title={reactorNames}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  {reaction.count > 1 ? (
                    <b className="text-xs text-muted-foreground">
                      {reaction.count}
                    </b>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : null}
        <footer className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex h-5 items-center rounded px-1.5 text-2xs font-bold uppercase",
              stateClassName[message.triage.state],
            )}
          >
            {stateLabels[message.triage.state]}
          </span>
          {message.triage.kind !== "context" ? (
            <small className="text-2xs text-muted-foreground uppercase">
              {message.triage.kind}
            </small>
          ) : null}
          {message.tickets.map((ticket) => (
            <Button
              key={ticket.id}
              onClick={() => onOpenTicket(ticket.id)}
              size="xs"
              title={ticket.title}
              type="button"
              variant="outline"
            >
              <TicketCheck size={11} /> #{ticket.number}
            </Button>
          ))}
        </footer>
      </div>
    </article>
  );
}
