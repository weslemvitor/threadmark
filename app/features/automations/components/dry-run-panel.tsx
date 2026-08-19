"use client";

import { AlertTriangle, CheckCircle2, FlaskConical, LoaderCircle, RotateCcw, X } from "lucide-react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { ScrollArea } from "@/app/components/ui/scroll-area";
import { cn } from "@/app/lib/utils";
import type { AutomationExecution } from "../domain";

type DryRunPanelProps = {
  execution: AutomationExecution | null;
  error: string | null;
  nodeLabels: Map<string, string>;
  running: boolean;
  onClose: () => void;
  onRunAgain: () => void;
};

export function DryRunPanel({
  execution,
  error,
  nodeLabels,
  running,
  onClose,
  onRunAgain,
}: DryRunPanelProps) {
  const passed = execution?.steps.filter((step) => step.status === "passed").length ?? 0;

  return (
    <aside className="w-[min(360px,calc(100vw-48px))] overflow-hidden rounded-xl border bg-card shadow-xl">
      <header className="flex items-start gap-2 border-b p-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          {running ? <LoaderCircle className="animate-spin" size={16} /> : <FlaskConical size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Dry Run do fluxo</h3>
            <Badge variant={error ? "destructive" : running ? "outline" : "secondary"}>
              {error ? "Falhou" : running ? "Executando" : execution?.status === "completed" ? "Aprovado" : "Concluído"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Simulação segura: nenhuma ação interna ou externa é executada.
          </p>
        </div>
        <Button aria-label="Fechar resultado do teste" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X size={13} />
        </Button>
      </header>

      {running ? (
        <div className="grid min-h-40 place-items-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <div>
            <LoaderCircle className="mx-auto mb-2 animate-spin text-primary" size={22} />
            Conferindo gatilhos, caminhos e configurações…
          </div>
        </div>
      ) : error ? (
        <div className="grid gap-3 p-3">
          <div className="flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 shrink-0" size={15} />
            <div className="min-w-0">
              <strong className="block">O fluxo não passou no Dry Run</strong>
              <p className="mt-1 break-words leading-relaxed">{error}</p>
            </div>
          </div>
          <Button className="w-full" onClick={onRunAgain} size="sm" type="button" variant="outline">
            <RotateCcw size={13} /> Tentar novamente
          </Button>
        </div>
      ) : execution ? (
        <>
          <div className="flex items-center justify-between gap-3 border-b bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <span className="flex items-center gap-1.5 font-medium"><CheckCircle2 size={14} /> Fluxo pronto para executar</span>
            <span>{passed}/{execution.steps.length} etapas</span>
          </div>
          <ScrollArea className="max-h-72">
            <ol className="grid gap-0 p-2">
              {execution.steps.map((step, index) => (
                <li className="flex gap-2 rounded-lg p-2 hover:bg-muted/60" key={`${step.nodeId}-${index}`}>
                  <span
                    className={cn(
                      "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold",
                      step.status === "passed" && "bg-emerald-100 text-emerald-700",
                      step.status === "failed" && "bg-destructive/10 text-destructive",
                      step.status !== "passed" && step.status !== "failed" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {step.status === "passed" ? <CheckCircle2 size={12} /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-xs">
                      {nodeLabels.get(step.nodeId) ?? step.label}
                    </strong>
                    <p className="mt-0.5 break-words text-2xs leading-relaxed text-muted-foreground">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </ScrollArea>
          <footer className="border-t p-2">
            <Button className="w-full" onClick={onRunAgain} size="sm" type="button" variant="outline">
              <RotateCcw size={13} /> Testar novamente
            </Button>
          </footer>
        </>
      ) : null}
    </aside>
  );
}
