"use client";

import { Clock3, Plus, Search, Workflow } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { formatRelativeTime } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";
import type { AutomationStatus, AutomationSummary } from "../domain";

const labels: Record<AutomationStatus, string> = {
  active: "Ativa",
  archived: "Arquivada",
  draft: "Rascunho",
  paused: "Pausada",
};

const statusStyles: Record<AutomationStatus, string> = {
  active: "border-emerald-200 bg-emerald-100 text-emerald-800",
  archived: "border-border bg-muted text-muted-foreground",
  draft: "border-amber-200 bg-amber-50 text-amber-800",
  paused: "border-blue-200 bg-blue-50 text-blue-800",
};

const statusDotStyles: Record<AutomationStatus, string> = {
  active: "bg-emerald-600",
  archived: "bg-muted-foreground",
  draft: "bg-amber-500",
  paused: "bg-blue-500",
};

type AutomationListProps = {
  items: AutomationSummary[];
  loading: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
};

export function AutomationList({
  items,
  loading,
  onCreate,
  onSelect,
  selectedId,
}: AutomationListProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return items;
    return items.filter((item) =>
      `${item.name} ${item.description ?? ""}`.toLocaleLowerCase("pt-BR").includes(normalized),
    );
  }, [items, query]);

  return (
    <Card className="min-h-0 min-w-0 gap-0 overflow-hidden p-0">
      <div className="border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Fluxos</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{items.length} automação(ões)</p>
          </div>
          <Button aria-label="Criar fluxo" onClick={onCreate} size="icon-sm" type="button">
            <Plus size={14} />
          </Button>
        </div>
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
          <Input className="pl-9" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar fluxo" value={query} />
        </div>
      </div>
      <div className="grid max-h-full min-h-0 gap-2 overflow-y-auto p-2 max-[900px]:max-h-72">
        {loading ? (
          <div className="grid min-h-36 place-items-center text-xs text-muted-foreground">Carregando fluxos…</div>
        ) : null}
        {!loading && !filtered.length ? (
          <div className="grid min-h-44 place-items-center content-center gap-2 px-4 text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground"><Workflow size={20} /></span>
            <strong className="text-sm">{query ? "Nenhum fluxo encontrado" : "Nenhum fluxo criado"}</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {query ? "Tente outro termo de busca." : "Crie um fluxo para automatizar o trabalho interno."}
            </span>
            {!query ? <Button className="mt-1" onClick={onCreate} size="sm" type="button"><Plus size={14} /> Novo fluxo</Button> : null}
          </div>
        ) : null}
        {filtered.map((item) => (
          <Button
            className={cn(
              "relative h-auto min-w-0 items-start justify-start overflow-hidden whitespace-normal rounded-xl border p-3 pl-3.5 text-left",
              item.status === "active" && "border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50",
              item.status === "draft" && "border-amber-200/80 bg-amber-50/35 hover:bg-amber-50/60",
              item.status === "paused" && "border-blue-200/80 bg-blue-50/35 hover:bg-blue-50/60",
              selectedId === item.id && "border-primary bg-primary/5",
            )}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
            variant="ghost"
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-2 left-0 w-1 rounded-r-full",
                statusDotStyles[item.status],
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-start justify-between gap-2">
                <strong className="min-w-0 truncate text-xs font-semibold">{item.name}</strong>
                <Badge className={cn("shrink-0", statusStyles[item.status])} variant="outline">
                  <span className={cn("mr-1.5 size-1.5 rounded-full", statusDotStyles[item.status])} />
                  {labels[item.status]}
                </Badge>
              </span>
              <span className="mt-1.5 line-clamp-2 text-xs font-normal leading-relaxed text-muted-foreground">
                {item.description || "Sem descrição."}
              </span>
              <span className="mt-2 flex items-center justify-between gap-2 text-2xs font-normal text-muted-foreground">
                <span>{item.nodeCount} etapas · {item.runCount} execuções</span>
                <span className="flex items-center gap-1"><Clock3 size={11} /> {formatRelativeTime(item.updatedAt)}</span>
              </span>
            </span>
          </Button>
        ))}
      </div>
    </Card>
  );
}
