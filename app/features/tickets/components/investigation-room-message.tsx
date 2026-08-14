import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Clipboard,
  Copy,
  ExternalLink,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/app/components/ui/button";
import { formatMessageTime } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";
import type { InvestigationThreadDto } from "@/shared/contracts";

const phaseLabels: Record<string, string> = {
  context: "Contexto",
  analysis: "Análise",
  needs_information: "Aguardando informações",
  investigation: "Investigação",
  evidence: "Evidências",
  conclusion: "Conclusão",
  answer: "Resposta sugerida",
  error: "Falha",
};

function getPhaseLabel(phase: string | null | undefined): string | null {
  if (!phase) return null;
  return phaseLabels[phase] ?? phase.replaceAll("_", " ");
}

function CopyResultButton({
  body,
  messageId,
}: {
  body: string;
  messageId: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      const temporary = document.createElement("textarea");
      temporary.value = body;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.appendChild(temporary);
      temporary.select();
      const didCopy = document.execCommand("copy");
      temporary.remove();
      if (!didCopy) return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }

  return (
    <Button
      aria-label={`Copiar resposta sugerida da mensagem ${messageId}`}
      className="mt-3 gap-1.5"
      onClick={() => void copy()}
      size="sm"
      type="button"
      variant="outline"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copiada" : "Copiar resposta"}
    </Button>
  );
}

export function InvestigationRoomMessage({
  message,
  currentSuggestedResponse,
}: {
  message: InvestigationThreadDto["messages"][number];
  currentSuggestedResponse: string | null;
}) {
  const assistant = message.role === "assistant";
  const phase = getPhaseLabel(message.phase);
  const responseIsCurrent = Boolean(
    message.suggestedResponse &&
      currentSuggestedResponse === message.suggestedResponse,
  );

  return (
    <article
      className={cn(
        "mb-4 flex gap-3",
        !assistant && "ml-auto max-w-[88%] flex-row-reverse",
      )}
    >
      <div
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full",
          assistant
            ? "bg-primary/10 text-primary"
            : "bg-slate-900 text-white",
        )}
        aria-hidden="true"
      >
        {assistant ? <Bot size={16} /> : <UserRound size={16} />}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-xl border p-3",
          assistant
            ? "border-border bg-card"
            : "border-slate-200 bg-slate-50",
        )}
      >
        <header className="flex flex-wrap items-center gap-2">
          <strong className="text-xs text-foreground">{assistant ? "Agente de IA" : "Operador"}</strong>
          {phase ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">{phase}</span> : null}
          <time className="ml-auto text-xs text-muted-foreground" dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt)}
          </time>
        </header>
        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{message.body}</div>

        {message.toolExecutions.length ? (
          <section
            className="mt-4 rounded-lg border border-border bg-muted/20 p-3"
            aria-label="Operações executadas pela investigação"
          >
            <h4 className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Wrench size={14} /> Operações executadas pelo Threadmark
            </h4>
            <div className="mt-2 grid gap-2">
              {message.toolExecutions.map((execution) => (
                <details
                  className={cn(
                    "rounded-md border bg-background px-3 py-2",
                    execution.status === "success"
                      ? "border-emerald-200"
                      : "border-destructive/20",
                  )}
                  key={`${message.id}-${execution.requestId}`}
                >
                  <summary className="flex cursor-pointer list-none items-start gap-2">
                    {execution.status === "success" ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <AlertCircle size={13} />
                    )}
                    <span className="min-w-0">
                      <strong className="block break-words text-xs text-foreground">{execution.toolName}</strong>
                      <small className="block text-xs text-muted-foreground">
                        {execution.operation} ·{" "}
                        {formatMessageTime(execution.executedAt)}
                      </small>
                    </span>
                  </summary>
                  <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">{execution.purpose}</p>
                  <code className="mt-2 block whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs text-foreground">{execution.argumentsJson}</code>
                  <div className="mt-2 border-t border-border pt-2">
                    <strong className="block text-xs text-foreground">{execution.summary}</strong>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-xs leading-relaxed text-slate-100">{execution.content}</pre>
                    {execution.reference ? (
                      <small className="mt-1 block break-all text-xs text-muted-foreground">{execution.reference}</small>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </section>
        ) : null}

        {message.evidence.length ? (
          <section
            className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3"
            aria-label="Evidências encontradas"
          >
            <h4 className="flex items-center gap-2 text-xs font-semibold text-emerald-950">
              <ShieldCheck size={14} /> Evidências encontradas
            </h4>
            <div className="mt-2 grid gap-2">
              {message.evidence.map((item, index) => (
                <article className="flex items-start gap-2 rounded-md border border-emerald-200 bg-background/75 p-2.5" key={`${message.id}-${item.source}-${index}`}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-100 text-emerald-700">
                    <Clipboard size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block break-words text-xs text-foreground">{item.summary}</strong>
                    <small className="mt-0.5 block break-all text-xs text-muted-foreground">
                      {item.source}
                      {item.reference ? ` · ${item.reference}` : ""}
                    </small>
                  </div>
                  {item.reference ? (
                    <ExternalLink size={13} />
                  ) : (
                    <CheckCircle2 size={13} />
                  )}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {message.suggestedResponse ? (
          <section
            className={cn(
              "mt-4 rounded-lg border p-3",
              responseIsCurrent
                ? "border-primary/25 bg-primary/5"
                : "border-border bg-muted/40 opacity-75",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Sparkles size={13} />
                {responseIsCurrent
                  ? "Resposta sugerida"
                  : "Resposta superada"}
              </span>
              <small className="text-xs text-muted-foreground">
                {responseIsCurrent
                  ? "Revise antes de usar manualmente no WhatsApp"
                  : "Mantida apenas no histórico; não use esta minuta"}
              </small>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{message.suggestedResponse}</p>
            {responseIsCurrent ? (
              <CopyResultButton
                body={message.suggestedResponse}
                messageId={message.id}
              />
            ) : null}
          </section>
        ) : null}

        {message.nextAction ? (
          <section className="mt-3 rounded-lg border border-sky-200 bg-sky-50/70 p-3">
            <strong className="text-xs text-sky-950">Próxima ação recomendada</strong>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-sky-900/75">{message.nextAction}</p>
          </section>
        ) : null}
      </div>
    </article>
  );
}
