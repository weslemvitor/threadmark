import { Boxes, CircleDot, Layers3, Tags } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { getCategoryName } from "@/app/lib/format";
import { type CategoryFacetType, type TicketCategoryCatalog } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";

const facetLabels: Record<CategoryFacetType, string> = {
  reason: "Motivo",
  product: "Produto",
  platform: "Plataforma",
  symptom: "Sintoma",
  root_cause: "Causa raiz",
  resolution: "Resolução",
};

function createFacetBuckets() {
  return {
    reason: [],
    product: [],
    platform: [],
    symptom: [],
    root_cause: [],
    resolution: [],
  } as Record<CategoryFacetType, TicketCategoryCatalog[]>;
}

export function CategoriesView({
  categories,
  loading,
  onCreate,
}: {
  categories: TicketCategoryCatalog[];
  loading: boolean;
  onCreate: (input: {
    facet: CategoryFacetType;
    label: string;
    color?: string;
  }) => Promise<unknown>;
}) {
  const [facet, setFacet] = useState<CategoryFacetType>("reason");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const categoriesByFacet = useMemo(() => {
    const buckets = createFacetBuckets();
    for (const category of categories) {
      buckets[category.facet].push(category);
    }
    return buckets;
  }, [categories]);

  const totalTicketBindings = useMemo(
    () => categories.reduce((sum, category) => sum + category.ticketCount, 0),
    [categories],
  );

  const unlinkedCount = useMemo(
    () => categories.filter((category) => category.ticketCount === 0).length,
    [categories],
  );

  const totalCatalog = categories.length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedLabel = label.trim();
    if (!normalizedLabel || isSubmitting) return;

    setIsSubmitting(true);
    setCreateError(null);
    try {
      await onCreate({
        facet,
        label: normalizedLabel,
        color: color.trim() || undefined,
      });
      setLabel("");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Não foi possível criar a categoria.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) return <LoadingState label="Organizando taxonomia…" />;

  return (
    <div className="grid min-h-full min-w-0 gap-4 p-4 sm:p-5">
      <Card className="flex flex-col items-start gap-3 rounded-xl border-0 bg-linear-to-br from-slate-900 to-indigo-950 p-4 text-white shadow-sm sm:flex-row sm:items-center" variant="unstyled">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-primary/25 text-primary-foreground">
          <Layers3 size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Taxonomia multidimensional</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-300">
            Crie o catálogo persistido no SQLite. Categorias de motivo, produto,
            plataforma e sintoma também ficam disponíveis para a IA classificar os
            tickets.
          </p>
        </div>
        <b className="whitespace-nowrap rounded-lg border border-white/10 bg-primary/20 px-3 py-2 text-xs text-indigo-100">
          {totalCatalog} categoria{totalCatalog === 1 ? "" : "s"} · {totalTicketBindings} vínculos
        </b>
      </Card>

      <Card className="gap-3 p-4 py-4 shadow-sm">
        <form className="grid min-w-0 gap-3" onSubmit={submit}>
        <h3 className="text-sm font-semibold text-foreground">Criar categoria no catálogo da instalação</h3>
        <div className="grid items-end gap-3 md:grid-cols-[minmax(150px,170px)_minmax(0,1fr)_120px_120px]">
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Faceta</span>
            <Select
              disabled={isSubmitting}
              onValueChange={(value) => setFacet(value as CategoryFacetType)}
              value={facet}
            >
              <SelectTrigger className="h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(facetLabels) as CategoryFacetType[]).map((facetType) => (
                  <SelectItem key={facetType} value={facetType}>
                    {facetLabels[facetType]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Nome da categoria</span>
            <Input
              className="h-9 text-sm"
              disabled={isSubmitting}
              maxLength={40}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Ex.: Meta Ads, Falha no checkout"
              value={label}
            />
          </label>
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Cor</span>
            <Input
              aria-label="Cor da categoria"
              className="h-9 w-full min-w-0 cursor-pointer p-1"
              disabled={isSubmitting}
              onChange={(event) => setColor(event.target.value)}
              type="color"
              value={color || "#5b56d4"}
            />
          </label>
          <Button
            className="w-full md:w-auto"
            disabled={isSubmitting || !label.trim()}
            size="lg"
            type="submit"
            variant="default"
          >
            {isSubmitting ? "Criando…" : "Adicionar"}
          </Button>
        </div>
        {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
        </form>
      </Card>

      <div className="text-xs text-muted-foreground">
        <span>{unlinkedCount} sem vínculos</span>
      </div>

      {!totalCatalog ? (
        <EmptyState
          title="Nenhuma categoria cadastrada"
          description="Crie a primeira categoria para começar a classificar atendimentos."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(categoriesByFacet) as CategoryFacetType[]).map((facetType) => {
            const items = categoriesByFacet[facetType].sort((left, right) => {
              const delta = right.ticketCount - left.ticketCount;
              return delta !== 0 ? delta : left.label.localeCompare(right.label);
            });
            return (
              <Card className="min-w-0 gap-0 py-0 shadow-sm" key={facetType}>
                <header className="flex items-center gap-2.5 border-b border-border p-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">{facetType === "product" ? <Boxes size={17} /> : <Tags size={17} />}</span>
                  <div className="flex flex-col">
                    <h3 className="text-sm font-semibold text-foreground">{facetLabels[facetType]}</h3>
                    <small className="mt-0.5 text-xs text-muted-foreground">{items.length} categoria{items.length === 1 ? "" : "s"}</small>
                  </div>
                </header>
                <div className="grid px-3 py-2">
                  {items.map((category) => (
                    <article className="grid min-h-9 grid-cols-[8px_minmax(0,1fr)] items-center gap-2 border-b border-border last:border-b-0" key={category.id}>
                      <i className="size-1.5 rounded-full bg-primary" style={{ backgroundColor: category.color ?? undefined }} />
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-foreground">{getCategoryName(category)}</span>
                        <small className="ml-auto shrink-0 text-xs text-muted-foreground">{category.ticketCount} vínculo{category.ticketCount === 1 ? "" : "s"}</small>
                      </span>
                    </article>
                  ))}
                  {!items.length ? (
                    <p className="my-6 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                      <CircleDot size={14} />
                      Ainda sem dados confirmados
                    </p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
