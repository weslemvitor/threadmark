import {
  Check,
  CheckCheck,
  Clock3,
  LoaderCircle,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/app/components/ui/button";
import type { ConversationTriageBlock } from "@/app/lib/conversations";
import { formatMessageTime } from "@/app/lib/format";
import type { TicketSummary } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import type {
  ConversationSuggestionAnalysisDto,
  TriageAiSettingsDto,
} from "@/shared/contracts";

const aiProviderLabels: Record<
  NonNullable<TriageAiSettingsDto["providerId"]>,
  string
> = {
  codex: "Codex local",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

const blockReasonLabels: Record<string, string> = {
  explicit_new_topic: "A mensagem indica um novo assunto",
  quoted_open_ticket: "Resposta ligada a um ticket aberto",
  quoted_closed_ticket: "Resposta ligada a um ticket encerrado",
  different_store: "A mensagem menciona outro contexto",
  message_burst: "Continuação enviada em sequência",
  strong_continuation: "A mensagem indica continuação",
  topic_similarity: "Assunto semelhante a um ticket aberto",
  no_candidate: "Nenhum ticket aberto compatível",
  ambiguous: "O contexto ainda é ambíguo",
  social_only: "Interação social sem demanda",
  informational_only: "Informação sem solicitação de suporte",
};

type ProposedCategories = ConversationTriageBlock["proposedCategories"];

const proposedCategoryFacets: Array<{
  key: keyof ProposedCategories;
  label: string;
}> = [
  { key: "contactReason", label: "Motivo" },
  { key: "productArea", label: "Produto" },
  { key: "platform", label: "Plataforma" },
  { key: "symptom", label: "Sintoma" },
];

function getProposedCategoryChips(categories: ProposedCategories) {
  return proposedCategoryFacets.flatMap((facet) =>
    categories[facet.key]
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ facet: facet.label, value })),
  );
}

function blockReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return blockReasonLabels[reason] ?? reason.replaceAll("_", " ");
}

export function ConversationAiCard({
  settings,
  settingsLoading,
  suggestionAnalysis,
  suggestionStatus,
  suggestionsMuted,
  canTriggerAnalysis,
  triggeringAnalysis,
  busy,
  blocks,
  tickets,
  selectedMessageIds,
  loadingBlockId,
  actionBusy,
  onOpenSettings,
  onAnalyzeNow,
  onSelectBlock,
  onIgnoreBlock,
}: {
  settings: TriageAiSettingsDto | null;
  settingsLoading: boolean;
  suggestionAnalysis: ConversationSuggestionAnalysisDto | null;
  suggestionStatus: { title: string; description: string } | null;
  suggestionsMuted: boolean;
  canTriggerAnalysis: boolean;
  triggeringAnalysis: boolean;
  busy: boolean;
  blocks: ConversationTriageBlock[];
  tickets: TicketSummary[];
  selectedMessageIds: Set<string>;
  loadingBlockId: string | null;
  actionBusy: boolean;
  onOpenSettings: () => void;
  onAnalyzeNow: () => void;
  onSelectBlock: (block: ConversationTriageBlock) => void;
  onIgnoreBlock: (block: ConversationTriageBlock) => void;
}) {
  return (
    <section className="border-b border-border bg-card p-3.5 max-[1050px]:p-3">
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            Blocos sugeridos
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Demandas agrupadas automaticamente para sua revisão.
          </p>
        </div>
      </div>
      <div
        aria-busy={settingsLoading}
        className="mt-2.5 grid items-end gap-2 rounded-lg border border-primary/15 bg-primary/[0.035] p-2 max-[840px]:grid-cols-1 min-[841px]:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="grid min-w-0 gap-1">
          <span className="text-xs font-semibold text-primary">
            Configuração atual
          </span>
          <strong className="truncate text-xs leading-snug text-foreground">
            {settings
              ? `${
                  settings.connectionLabel ??
                  (settings.providerId
                    ? aiProviderLabels[settings.providerId]
                    : "Sem conexão")
                } · ${
                  settings.model === "default"
                    ? "Padrão da conta"
                    : settings.model
                }`
              : "Carregando modelo…"}
          </strong>
          <small
            className={cn(
              "w-fit rounded-full bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground",
              settings?.enabled &&
                "bg-emerald-100 text-emerald-800",
            )}
          >
            {settings?.enabled ? "IA ativa" : "IA pausada"}
          </small>
        </div>
        <Button
          className="max-[840px]:w-full"
          onClick={onOpenSettings}
          size="sm"
          type="button"
          variant="outline"
        >
          <Settings2 size={13} /> Configurar IA
        </Button>
      </div>
      {!settings ? (
        <small className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
          {settingsLoading
            ? "Carregando configuração da IA…"
            : "Configuração da IA indisponível"}
        </small>
      ) : null}
      {suggestionAnalysis &&
      suggestionStatus &&
      suggestionAnalysis.state !== "idle" &&
      !suggestionsMuted ? (
        <div
          aria-live="polite"
          className={cn(
            "mt-2.5 grid min-w-0 gap-2 rounded-lg border border-primary/15 bg-primary/5 p-2.5 text-muted-foreground",
            (suggestionAnalysis.state === "waiting_for_context" ||
              suggestionAnalysis.state === "waiting_for_audio") &&
              "border-amber-200 bg-amber-50 text-amber-800",
            (suggestionAnalysis.state === "queued" ||
              suggestionAnalysis.state === "running") &&
              "border-sky-200 bg-sky-50 text-sky-800",
          )}
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card text-primary">
              <Clock3 size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <strong className="block text-xs leading-snug text-foreground">
                {suggestionStatus.title}
              </strong>
              <p className="mt-1 break-words text-xs leading-relaxed">
                {suggestionStatus.description}
              </p>
              <small className="mt-1.5 block text-xs leading-snug text-muted-foreground">
                {suggestionAnalysis.pendingMessageCount} pendente(s)
                {suggestionAnalysis.nextAnalysisAt
                  ? ` · prevista para ${formatMessageTime(
                      suggestionAnalysis.nextAnalysisAt,
                    )}`
                  : ""}
              </small>
            </div>
          </div>
          {canTriggerAnalysis ? (
            <Button
              disabled={triggeringAnalysis || busy}
              onClick={onAnalyzeNow}
              size="sm"
              type="button"
            >
              {triggeringAnalysis ? (
                <LoaderCircle className="animate-spin" size={13} />
              ) : (
                <Sparkles size={13} />
              )}
              {triggeringAnalysis ? "Solicitando análise…" : "Analisar agora"}
            </Button>
          ) : null}
          <small className="block break-words text-xs leading-relaxed text-muted-foreground">
            Analisar agora apenas antecipa a avaliação da IA; o botão não cria um
            ticket.
          </small>
        </div>
      ) : null}
      {blocks.length ? (
        <div className="mt-3 grid gap-2">
          {blocks.map((block) => {
            const selected =
              block.messageIds.length === selectedMessageIds.size &&
              block.messageIds.every((id) => selectedMessageIds.has(id));
            const targetTicket = block.suggestedTicketId
              ? tickets.find((ticket) => ticket.id === block.suggestedTicketId) ??
                null
              : null;
            const actionLabel =
              block.suggestedAction === "attach"
                ? targetTicket
                  ? `Continuar ticket #${targetTicket.number}`
                  : "Continuar ticket aberto"
                : block.suggestedAction === "ignore"
                  ? "Guardar sem criar ticket"
                  : "Novo ticket sugerido";
            const reason = blockReasonLabel(block.reason);
            const proposedCategories = getProposedCategoryChips(
              block.proposedCategories,
            );
            const priorityLabel = {
              low: "Baixa",
              normal: "Normal",
              high: "Alta",
              urgent: "Urgente",
            }[block.suggestedPriority];

            return (
              <article
                className={cn(
                  "rounded-lg border border-primary/15 bg-primary/[0.025] p-2.5",
                  selected && "border-primary/45 bg-primary/10 ring-2 ring-primary/5",
                  block.suggestedAction === "ignore" &&
                    "border-border bg-muted/30",
                  block.suggestedAction === "attach" &&
                    "border-emerald-200 bg-emerald-50/40",
                )}
                key={block.id}
              >
                <header className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs font-semibold text-primary">
                    <Sparkles size={13} /> {actionLabel}
                  </span>
                  <b className="text-xs text-emerald-700">
                    {block.messageIds.length}{" "}
                    {block.messageIds.length === 1 ? "msg" : "msgs"}
                  </b>
                </header>
                <strong className="mt-2 block text-xs leading-snug text-foreground">
                  {block.title}
                </strong>
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                  {block.summary}
                </p>
                {proposedCategories.length ? (
                  <div
                    aria-label="Categorias propostas pela IA"
                    className="mt-2 flex max-w-full flex-wrap gap-1"
                  >
                    {proposedCategories.map((category) => (
                      <span
                        className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-md border border-primary/15 bg-primary/10 px-1.5 py-1 text-xs font-semibold whitespace-normal text-primary"
                        key={`${category.facet}-${category.value}`}
                      >
                        <small className="text-2xs font-semibold text-primary/65 uppercase">
                          {category.facet}
                        </small>
                        {category.value}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  <span
                    className={cn(
                      "inline-flex min-h-5 items-center rounded-full px-1.5 text-2xs font-semibold",
                      block.suggestedPriority === "urgent" &&
                        "bg-red-100 text-red-800",
                      block.suggestedPriority === "high" &&
                        "bg-amber-100 text-amber-800",
                      block.suggestedPriority === "normal" &&
                        "bg-primary/10 text-primary",
                      block.suggestedPriority === "low" &&
                        "bg-muted text-muted-foreground",
                    )}
                  >
                    Prioridade {priorityLabel}
                  </span>
                  {block.confidence !== null ? (
                    <span className="inline-flex min-h-5 items-center rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
                      {Math.round(block.confidence * 100)}% confiança
                    </span>
                  ) : null}
                  {block.ai ? (
                    <span className="inline-flex min-h-5 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-2xs font-medium text-primary">
                      <Sparkles size={11} /> IA · {block.ai.model}
                    </span>
                  ) : (
                    <span className="inline-flex min-h-5 items-center rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
                      Regras locais
                    </span>
                  )}
                  {block.ai?.fallbackUsed ? (
                    <span className="inline-flex min-h-5 items-center rounded-full bg-amber-100 px-1.5 text-2xs font-medium text-amber-800">
                      Fallback local
                    </span>
                  ) : null}
                  {reason ? (
                    <span className="inline-flex min-h-5 items-center rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
                      {reason}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <Button
                    className="h-auto min-h-8 gap-1 px-2 py-1.5 leading-4 whitespace-normal"
                    disabled={loadingBlockId !== null || actionBusy}
                    onClick={() => onSelectBlock(block)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {loadingBlockId === block.id && !actionBusy ? (
                      <LoaderCircle className="animate-spin" size={13} />
                    ) : selected ? (
                      <Check size={13} />
                    ) : (
                      <CheckCheck size={13} />
                    )}
                    {loadingBlockId === block.id && !actionBusy
                      ? "Carregando mensagens…"
                      : "Revisar"}
                  </Button>
                  <Button
                    className="h-auto min-h-8 gap-1 px-2 py-1.5 leading-4 whitespace-normal"
                    disabled={loadingBlockId !== null || actionBusy}
                    onClick={() => onIgnoreBlock(block)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {loadingBlockId === block.id && actionBusy ? (
                      <LoaderCircle className="animate-spin" size={13} />
                    ) : (
                      <X size={13} />
                    )}
                    {loadingBlockId === block.id && actionBusy
                      ? "Ignorando…"
                      : "Ignorar"}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="mt-2.5 flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-primary/20 bg-primary/[0.025] p-3 text-center text-primary">
          <Sparkles size={18} />
          <strong className="mt-2 text-xs text-foreground">
            Nenhum bloco pendente
          </strong>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {suggestionsMuted
              ? "O histórico continua sendo salvo. Reative as sugestões ou selecione mensagens manualmente para criar um ticket."
              : "Você ainda pode selecionar mensagens manualmente ou restaurar itens ignorados para uma nova triagem."}
          </p>
        </div>
      )}
    </section>
  );
}
