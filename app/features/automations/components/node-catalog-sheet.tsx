"use client";

import {
  BellRing,
  CheckCircle2,
  Clock3,
  Flag,
  GitBranch,
  MessageSquareShare,
  NotebookPen,
  RefreshCw,
  Search,
  SquareKanban,
  Ticket,
  UserCheck,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { useMemo, useState, type ComponentType, type DragEvent } from "react";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { ScrollArea } from "@/app/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { cn } from "@/app/lib/utils";
import {
  automationCategoryDescriptions,
  automationCategoryLabels,
  type AutomationNodeCategory,
  type AutomationNodeDefinition,
} from "../domain";

const categoryOrder: AutomationNodeCategory[] = [
  "trigger",
  "flow_control",
  "internal_action",
];

const icons: Record<string, ComponentType<{ size?: number }>> = {
  "bell-ring": BellRing,
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
};

type NodeCatalogSheetProps = {
  catalog: AutomationNodeDefinition[];
  onAdd: (catalogId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function NodeCatalogSheet({
  catalog,
  onAdd,
  onOpenChange,
  open,
}: NodeCatalogSheetProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return catalog;
    return catalog.filter((item) =>
      `${item.label} ${item.description} ${automationCategoryLabels[item.category]}`
        .toLocaleLowerCase("pt-BR")
        .includes(normalized),
    );
  }, [catalog, query]);
  function startDrag(event: DragEvent<HTMLButtonElement>, catalogId: string) {
    event.dataTransfer.setData("application/threadmark-automation-node", catalogId);
    event.dataTransfer.effectAllowed = "copy";
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(520px,100vw)]">
        <SheetHeader>
          <SheetTitle>Adicionar etapa</SheetTitle>
          <SheetDescription>
            Clique para adicionar ou arraste uma etapa para o canvas.
          </SheetDescription>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
            <Input
              aria-label="Buscar etapa"
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar gatilho, ação ou app"
              value={query}
            />
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-6 p-4">
            {categoryOrder.map((category) => {
              const items = filtered.filter((item) => item.category === category);
              if (!items.length) return null;
              return (
                <section className="grid gap-3" key={category}>
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {automationCategoryLabels[category]}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {automationCategoryDescriptions[category]}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-[440px]:grid-cols-1">
                    {items.map((item) => {
                      const Icon = icons[item.icon] ?? Ticket;
                      return (
                        <Button
                          className="h-auto min-w-0 items-start justify-start gap-3 whitespace-normal rounded-xl border p-3 text-left"
                          draggable
                          key={item.id}
                          onClick={() => {
                            onAdd(item.id);
                            onOpenChange(false);
                          }}
                          onDragStart={(event) => startDrag(event, item.id)}
                          type="button"
                          variant="outline"
                        >
                          <span
                            className={cn(
                              "grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary",
                              item.accent === "blue" && "bg-blue-50 text-blue-600",
                              item.accent === "amber" && "bg-amber-50 text-amber-600",
                              item.accent === "emerald" && "bg-emerald-50 text-emerald-600",
                            )}
                          >
                            <Icon size={16} />
                          </span>
                          <span className="min-w-0">
                            <strong className="block break-words text-xs font-semibold">{item.label}</strong>
                            <span className="mt-1 line-clamp-3 text-xs font-normal leading-relaxed text-muted-foreground">
                              {item.description}
                            </span>
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {!filtered.length && query ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-xs text-muted-foreground">
                Nenhuma etapa encontrada para “{query}”.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
