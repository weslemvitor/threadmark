import {
  ArchiveRestore,
  BellOff,
  ChevronLeft,
  Link2,
  LoaderCircle,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  TicketPlus,
  X,
} from "lucide-react";
import type {
  KeyboardEventHandler,
  PointerEventHandler,
  RefObject,
  TouchEventHandler,
  WheelEventHandler,
} from "react";

import { LoadingState } from "@/app/components/shared";
import { Button } from "@/app/components/ui/button";
import type { ConversationDetail } from "@/app/lib/conversations";
import { formatDayDate } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";
import { ConversationAvatar } from "./conversation-list-item";
import { ConversationMessageBubble } from "./conversation-message";

export function ConversationChat({
  selectedConversationId,
  detail,
  detailLoading,
  loadingEarlier,
  hasMore,
  selectedMessageIds,
  selectionLocked,
  hasExternalSelection,
  hasTicketedSelection,
  chatScrollRef,
  chatContentRef,
  onBack,
  onOpenTriage,
  onLoadEarlier,
  onScroll,
  onKeyDown,
  onPointerDown,
  onTouchStart,
  onWheel,
  onToggleMessage,
  onOpenTicket,
  onCreateTicket,
  onAttachTicket,
  onClearSelection,
}: {
  selectedConversationId: string | null;
  detail: ConversationDetail | null;
  detailLoading: boolean;
  loadingEarlier: boolean;
  hasMore: boolean;
  selectedMessageIds: Set<string>;
  selectionLocked: boolean;
  hasExternalSelection: boolean;
  hasTicketedSelection: boolean;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  chatContentRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onOpenTriage: () => void;
  onLoadEarlier: () => void;
  onScroll: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onTouchStart: TouchEventHandler<HTMLDivElement>;
  onWheel: WheelEventHandler<HTMLDivElement>;
  onToggleMessage: (messageId: string, shiftKey: boolean) => void;
  onOpenTicket: (ticketId: string) => void;
  onCreateTicket: () => void;
  onAttachTicket: () => void;
  onClearSelection: () => void;
}) {
  const selectedDetail =
    detail?.conversation.id === selectedConversationId ? detail : null;

  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col bg-muted/20 max-[760px]:h-full max-[760px]:w-full max-[760px]:shrink-0",
        selectedConversationId ? "max-[760px]:flex" : "max-[760px]:hidden",
      )}
      aria-label="Histórico da conversa"
    >
      {!selectedConversationId ? (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center">
          <span className="grid size-14 place-items-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
            <MessagesSquare size={26} />
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            Escolha uma conversa
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Leia o contexto completo, selecione as mensagens da demanda e decida
            como elas entram na operação.
          </p>
        </div>
      ) : null}
      {selectedConversationId && detailLoading && !detail ? (
        <LoadingState label="Abrindo histórico…" />
      ) : null}
      {selectedDetail ? (
        <>
          <header className="flex min-h-[67px] shrink-0 items-center gap-2.5 border-b border-border bg-card/95 px-3 py-2 shadow-sm max-[760px]:gap-2 max-[760px]:px-2">
            <Button
              aria-label="Voltar para a lista"
              className="hidden max-[760px]:inline-grid"
              onClick={onBack}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeft size={18} />
            </Button>
            <ConversationAvatar conversation={selectedDetail.conversation} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {selectedDetail.conversation.subject}
              </h2>
              <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                {selectedDetail.conversation.client.name}
                <span>·</span>
                {selectedDetail.conversation.scope === "group"
                  ? "Grupo do WhatsApp"
                  : "Conversa privada"}
              </p>
            </div>
            <span className="flex flex-col items-center text-xs text-muted-foreground max-[760px]:hidden">
              {selectedDetail.conversation.suggestionsMuted ? (
                <>
                  <BellOff size={14} /> pausadas
                </>
              ) : (
                <>
                  <b className="text-sm text-primary">
                    {selectedDetail.conversation.pendingCount}
                  </b>{" "}
                  pendentes
                </>
              )}
            </span>
            <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 text-xs font-semibold whitespace-nowrap text-emerald-700 max-[1050px]:hidden">
              <ShieldCheck size={12} /> Captura inbound
            </span>
            <Button
              aria-label="Abrir painel de triagem"
              className="hidden max-[900px]:inline-grid"
              onClick={onOpenTriage}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Sparkles size={17} />
            </Button>
          </header>
          <div
            aria-busy={detailLoading || loadingEarlier}
            aria-label={`Histórico de mensagens de ${selectedDetail.conversation.subject}`}
            className="min-h-0 flex-1 overflow-y-auto px-[clamp(13px,2.2vw,28px)] pt-3 pb-7 overscroll-contain max-[760px]:px-2.5 max-[760px]:pb-20"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onScroll={onScroll}
            onTouchStart={onTouchStart}
            onWheel={onWheel}
            ref={chatScrollRef}
            role="log"
            tabIndex={0}
          >
            <div
              className="min-w-0"
              ref={chatContentRef}
            >
              {hasMore ? (
                <Button
                  className="mx-auto my-2.5"
                  disabled={loadingEarlier}
                  onClick={onLoadEarlier}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {loadingEarlier ? (
                    <LoaderCircle className="animate-spin" size={14} />
                  ) : (
                    <ArchiveRestore size={14} />
                  )}
                  {loadingEarlier
                    ? "Carregando histórico…"
                    : "Carregar mensagens anteriores"}
                </Button>
              ) : selectedDetail.messages.length ? (
                <span className="mx-auto my-2.5 block w-fit text-xs text-muted-foreground">
                  Início do histórico armazenado
                </span>
              ) : null}
              <div className="mx-auto mb-4 flex w-fit max-w-[90%] items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/90 px-2.5 py-2 text-xs text-emerald-700 max-[760px]:max-w-full">
                <ShieldCheck size={15} />
                <span>
                  Histórico capturado do WhatsApp. Esta tela não possui envio de
                  mensagens.
                </span>
              </div>
              {selectedDetail.messages.map((message, index) => {
                const previous = selectedDetail.messages[index - 1];
                const showDate =
                  !previous ||
                  formatDayDate(previous.occurredAt) !==
                    formatDayDate(message.occurredAt);
                return (
                  <div
                    className="min-w-0"
                    data-conversation-message-id={message.id}
                    key={message.id}
                  >
                    {showDate ? (
                      <div className="my-3.5 flex items-center before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                        <span className="mx-2.5 rounded-full border border-border bg-card/85 px-2 py-1 text-xs whitespace-nowrap text-muted-foreground">
                          {formatDayDate(message.occurredAt)}
                        </span>
                      </div>
                    ) : null}
                    <ConversationMessageBubble
                      message={message}
                      onOpenTicket={onOpenTicket}
                      onSelect={(shiftKey) =>
                        onToggleMessage(message.id, shiftKey)
                      }
                      selected={selectedMessageIds.has(message.id)}
                      selectionLocked={selectionLocked}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {selectedMessageIds.size ? (
            <div className="absolute right-2 bottom-2 left-2 z-20 hidden min-h-12 items-center gap-1.5 overflow-x-auto rounded-xl border border-white/10 bg-slate-900/95 p-1.5 text-white shadow-xl max-[760px]:flex">
              <span className="flex min-w-16 items-center gap-1 text-xs">
                <b className="text-sm">{selectedMessageIds.size}</b> selecionadas
              </span>
              <Button
                disabled={
                  !hasExternalSelection ||
                  hasTicketedSelection ||
                  selectionLocked
                }
                onClick={onCreateTicket}
                size="lg"
                type="button"
                variant="secondary"
              >
                <TicketPlus size={15} /> Criar
              </Button>
              <Button
                disabled={selectionLocked}
                onClick={onAttachTicket}
                size="lg"
                type="button"
                variant="secondary"
              >
                <Link2 size={15} /> Anexar
              </Button>
              <Button
                onClick={onOpenTriage}
                size="lg"
                type="button"
                variant="secondary"
              >
                <Sparkles size={15} /> Mais
              </Button>
              <Button
                aria-label="Limpar seleção"
                onClick={onClearSelection}
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <X size={16} />
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
