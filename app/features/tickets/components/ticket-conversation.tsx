import {
  AlertCircle,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  Unlink2,
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  AudioAttachment,
  InlineImageAttachment,
  isImageAttachment,
} from "@/app/components/shared";
import { EmptyState } from "@/app/components/shared";
import { Button } from "@/app/components/ui/button";
import { API_URL } from "@/app/lib/api";
import {
  formatBytes,
  formatFullDate,
  formatMessageTime,
  formatPhoneNumber,
} from "@/app/lib/format";
import { cn } from "@/app/lib/utils";
import {
  describeTimelineEvent,
  isInternalNoteTimelineEvent,
  isOperationalTimelineEvent,
} from "@/app/lib/timeline-events";
import type {
  Attachment,
  TicketDetail as TicketDetailType,
  TimelineMessageDto,
} from "@/app/lib/types";
import {
  InternalNoteItem,
  type TicketNoteMutation,
} from "./ticket-notes";

function AttachmentCard({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "audio") {
    return <AudioAttachment attachment={attachment} className="mt-2" />;
  }

  if (isImageAttachment(attachment)) {
    return <InlineImageAttachment attachment={attachment} />;
  }

  return (
    <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-background/80 p-2.5">
      <span className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
        <FileText size={18} />
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-xs text-foreground">
          {attachment.fileName ?? "Documento"}
        </strong>
        <small className="mt-0.5 block text-xs text-muted-foreground">
          {attachment.mimeType}
          {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
        </small>
      </span>
      {attachment.available ? (
        <span className="text-emerald-600" title="Arquivo armazenado localmente">
          <Check size={13} />
        </span>
      ) : (
        <span className="text-amber-600" title="Arquivo não recuperado">
          <AlertCircle size={14} />
        </span>
      )}
      {attachment.extractedText ? (
        <details className="col-span-full rounded-md bg-muted/60 px-2.5 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-foreground">
            Texto extraído
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {attachment.extractedText}
          </p>
        </details>
      ) : null}
      {attachment.available && attachment.url ? (
        <a
          className="col-span-full inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          href={`${API_URL}${attachment.url}`}
          rel="noreferrer"
          target="_blank"
        >
          Abrir anexo <ExternalLink size={11} />
        </a>
      ) : null}
    </div>
  );
}

function MessageItem({
  message,
  capturedResponse,
  detachMutationInProgress,
  detaching,
  onDetach,
}: {
  message: TimelineMessageDto;
  capturedResponse: boolean;
  detachMutationInProgress: boolean;
  detaching: boolean;
  onDetach?: (messageId: string) => Promise<boolean>;
}) {
  const fromEmployee = message.sender.isStaff;
  const senderPhone = formatPhoneNumber(message.sender.phoneE164);
  const senderNameDigits = message.sender.displayName.replace(/\D/g, "");
  const senderPhoneDigits = message.sender.phoneE164?.replace(/\D/g, "") ?? "";
  const showSenderPhone =
    !fromEmployee &&
    Boolean(senderPhone) &&
    (!senderNameDigits ||
      (!senderPhoneDigits.endsWith(senderNameDigits) &&
        !senderNameDigits.endsWith(senderPhoneDigits)));
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  const detachTitleId = useId();
  const detachDescriptionId = useId();
  const detachButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDetachButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDetachButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmingDetach) cancelDetachButtonRef.current?.focus();
  }, [confirmingDetach]);

  const cancelDetaching = () => {
    setConfirmingDetach(false);
    window.requestAnimationFrame(() => detachButtonRef.current?.focus());
  };

  return (
    <article
      aria-busy={detaching}
      className={cn(
        "group flex w-full min-w-0 items-start gap-2 px-[clamp(13px,2.2vw,28px)] pb-2.5 max-[760px]:px-2.5",
        message.sender.isStaff && "justify-end",
      )}
    >
      <div
        className={cn(
          "relative min-w-44 max-w-[min(76%,690px)] rounded-[4px_12px_12px_12px] border border-border bg-card px-3 py-2 shadow-sm",
          message.sender.isStaff &&
            "rounded-[12px_4px_12px_12px] border-primary/20 bg-primary/10",
        )}
      >
        <header className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <strong className="min-w-0 break-words text-xs font-semibold text-primary">
            {message.sender.displayName || (fromEmployee ? "Equipe de suporte" : "Contato")}
          </strong>
          {fromEmployee ? (
            <span className="rounded bg-emerald-100 px-1 py-0.5 text-2xs font-bold text-emerald-800 uppercase">
              Equipe
            </span>
          ) : null}
          {showSenderPhone ? (
            <span className="text-xs text-muted-foreground">{senderPhone}</span>
          ) : null}
          {capturedResponse ? (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-2xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              Resposta manual capturada
            </span>
          ) : null}
          <time className="ml-auto shrink-0 text-xs text-muted-foreground" dateTime={message.occurredAt}>
            {formatMessageTime(message.occurredAt)}
          </time>
          {message.canDetach && onDetach ? (
            <Button
              aria-label="Desvincular mensagem do ticket"
              className="size-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
              disabled={detachMutationInProgress || confirmingDetach}
              onClick={() => setConfirmingDetach(true)}
              ref={detachButtonRef}
              size="icon"
              title="Desvincular do ticket"
              type="button"
              variant="ghost"
            >
              {detaching ? (
                <LoaderCircle className="animate-spin" size={13} />
              ) : (
                <Unlink2 size={13} />
              )}
            </Button>
          ) : null}
        </header>
        {message.text ? (
          <p className="mt-2 mb-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
            {message.text}
          </p>
        ) : null}
        {message.attachments.length ? (
          <div className="mt-2 grid gap-2">
            {message.attachments.map((attachment) => (
              <AttachmentCard attachment={attachment} key={attachment.id} />
            ))}
          </div>
        ) : null}
        {confirmingDetach && onDetach ? (
          <div
            aria-describedby={detachDescriptionId}
            aria-labelledby={detachTitleId}
            className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !detaching) {
                event.preventDefault();
                cancelDetaching();
                return;
              }
              if (event.key !== "Tab") return;
              const cancelButton = cancelDetachButtonRef.current;
              const confirmButton = confirmDetachButtonRef.current;
              if (
                event.shiftKey &&
                document.activeElement === cancelButton &&
                confirmButton
              ) {
                event.preventDefault();
                confirmButton.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === confirmButton &&
                cancelButton
              ) {
                event.preventDefault();
                cancelButton.focus();
              }
            }}
            role="alertdialog"
          >
            <div>
              <strong className="block text-xs text-foreground" id={detachTitleId}>
                Desvincular esta mensagem do ticket?
              </strong>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground" id={detachDescriptionId}>
                Ela continuará salva em Conversas e no SQLite. Apenas sairá do
                contexto deste ticket e das análises futuras.
              </span>
            </div>
            <footer className="mt-3 flex justify-end gap-2">
              <Button
                disabled={detaching}
                onClick={cancelDetaching}
                ref={cancelDetachButtonRef}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancelar
              </Button>
              <Button
                disabled={detaching}
                onClick={() => {
                  void onDetach(message.id).then((detached) => {
                    if (detached) setConfirmingDetach(false);
                  });
                }}
                ref={confirmDetachButtonRef}
                size="sm"
                type="button"
                variant="destructive"
              >
                {detaching ? (
                  <LoaderCircle className="animate-spin" size={13} />
                ) : (
                  <Unlink2 size={13} />
                )}
                {detaching ? "Desvinculando…" : "Desvincular"}
              </Button>
            </footer>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function TicketConversation({
  ticket,
  detachingMessageId = null,
  noteMutation = null,
  onDetachMessage,
  onUpdateNote,
  onDeleteNote,
  noteActionReturnFocusRef,
}: {
  ticket: TicketDetailType;
  detachingMessageId?: string | null;
  noteMutation?: TicketNoteMutation | null;
  onDetachMessage?: (messageId: string) => Promise<boolean>;
  onUpdateNote?: (
    noteId: string,
    body: string,
    expectedUpdatedAt: string,
  ) => Promise<boolean>;
  onDeleteNote?: (noteId: string) => Promise<boolean>;
  noteActionReturnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [showOperationalEvents, setShowOperationalEvents] = useState(false);
  const timelineContentId = `ticket-timeline-${ticket.id}`;

  if (!ticket.timeline.length) {
    return (
      <EmptyState
        title="Conversa ainda sem mensagens associadas"
        description="Assim que a captura vincular o contexto, ele aparecerá nesta linha do tempo."
      />
    );
  }

  const sentMessageIds = new Set(
    ticket.sentResponses.map((response) => response.messageId).filter(Boolean),
  );
  const operationalEventCount = ticket.timeline.filter(
    (item) => item.type === "event" && isOperationalTimelineEvent(item),
  ).length;
  const visibleTimeline = showOperationalEvents
    ? ticket.timeline
    : ticket.timeline.filter(
        (item) =>
          item.type === "message" || isInternalNoteTimelineEvent(item),
      );

  return (
    <div className="min-w-0 pb-6 pt-1">
      <div className="flex items-center gap-3 px-5 py-4 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
        <span className="shrink-0 rounded-full border border-border bg-card/85 px-2 py-1 text-xs">
          {formatFullDate(ticket.firstMessageAt)}
        </span>
      </div>
      {operationalEventCount ? (
        <div className="flex justify-center px-5 pb-3">
          <Button
            aria-controls={timelineContentId}
            aria-expanded={showOperationalEvents}
            onClick={() => setShowOperationalEvents((current) => !current)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Clock3 size={13} />
            {showOperationalEvents
              ? "Ocultar eventos"
              : `Mostrar eventos (${operationalEventCount})`}
          </Button>
        </div>
      ) : null}
      <div aria-live="polite" id={timelineContentId}>
        {visibleTimeline.map((item) =>
          item.type === "message" ? (
            <MessageItem
              capturedResponse={sentMessageIds.has(item.id)}
              detaching={detachingMessageId === item.id}
              detachMutationInProgress={detachingMessageId !== null}
              key={item.id}
              message={item}
              onDetach={onDetachMessage}
            />
          ) : isInternalNoteTimelineEvent(item) ? (
            <InternalNoteItem
              key={item.id}
              mutation={noteMutation}
              note={item}
              onDelete={onDeleteNote}
              onUpdate={onUpdateNote}
              returnFocusRef={noteActionReturnFocusRef}
            />
          ) : (
            <div className="mx-5 my-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" key={item.id}>
              <Clock3 className="shrink-0" size={13} />
              <span className="min-w-0 flex-1 break-words">{describeTimelineEvent(item)}</span>
              <time className="shrink-0">{formatMessageTime(item.occurredAt)}</time>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
