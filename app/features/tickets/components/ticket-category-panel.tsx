import { Plus, Tag, X } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useMemo,
  useState,
} from "react";

import { Button } from "@/app/components/ui/button";
import { Combobox, type ComboboxOption } from "@/app/components/ui/combobox";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { getCategoryName } from "@/app/lib/format";
import type {
  CategoryFacetType,
  TicketCategoryCatalog,
  TicketDetail as TicketDetailType,
} from "@/app/lib/types";

const categoryFacetLabels: Record<CategoryFacetType, string> = {
  reason: "Motivo",
  product: "Produto",
  platform: "Plataforma",
  symptom: "Sintoma",
  root_cause: "Causa raiz",
  resolution: "Resolução",
};

const categoryFacetOrder: CategoryFacetType[] = [
  "reason",
  "symptom",
  "product",
  "platform",
  "root_cause",
  "resolution",
];

export function CategoryPanel({
  ticket,
  sectionRef,
  categoryCatalog,
  canManageCategories,
  onOpenCategoryCatalog,
  onCreateCategory,
  onAttachCategory,
  onDetachCategory,
  categoryMutationInProgress,
}: {
  ticket: TicketDetailType;
  sectionRef?: RefObject<HTMLElement | null>;
  categoryCatalog: TicketCategoryCatalog[];
  canManageCategories: boolean;
  onOpenCategoryCatalog?: () => void;
  onCreateCategory?: (input: {
    facet: CategoryFacetType;
    label: string;
  }) => Promise<TicketCategoryCatalog>;
  onAttachCategory?: (ticketId: string, categoryId: string) => Promise<boolean>;
  onDetachCategory?: (ticketId: string, categoryId: string) => Promise<boolean>;
  categoryMutationInProgress: boolean;
}) {
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [isAttaching, setIsAttaching] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryFacet, setNewCategoryFacet] =
    useState<CategoryFacetType>("product");
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [categoryCreateError, setCategoryCreateError] = useState<string | null>(null);
  const assignedIds = useMemo(
    () => new Set(ticket.categories.map((category) => category.id)),
    [ticket.categories],
  );
  const availableCategories = useMemo(
    () =>
      categoryCatalog
        .filter((category) => !assignedIds.has(category.id))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [assignedIds, categoryCatalog],
  );
  const categoryOptions = useMemo<ComboboxOption[]>(
    () => categoryFacetOrder.flatMap((facet) =>
      availableCategories
        .filter((category) => category.facet === facet)
        .map((category) => ({
          value: category.id,
          label: getCategoryName(category),
          description: categoryFacetLabels[facet],
          group: categoryFacetLabels[facet],
          keywords: [category.label, categoryFacetLabels[facet]],
        })),
    ),
    [availableCategories],
  );
  const assignedByFacet = useMemo(() => {
    const buckets = {
      reason: [],
      product: [],
      platform: [],
      symptom: [],
      root_cause: [],
      resolution: [],
    } as Record<CategoryFacetType, TicketDetailType["categories"]>;
    for (const category of ticket.categories) buckets[category.facet].push(category);
    return buckets;
  }, [ticket.categories]);

  const submitAttach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCategoryId || !onAttachCategory) return;
    const before = selectedCategoryId;
    setIsAttaching(true);
    const attached = await onAttachCategory(ticket.id, selectedCategoryId);
    if (attached) setSelectedCategoryId("");
    if (!attached) setSelectedCategoryId(before);
    setIsAttaching(false);
  };

  const mutationBusy = categoryMutationInProgress || isAttaching;

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = newCategoryLabel.trim();
    if (!label || !onCreateCategory || !onAttachCategory || mutationBusy) return;
    setCreatingCategory(true);
    setCategoryCreateError(null);
    try {
      const category = await onCreateCategory({
        facet: newCategoryFacet,
        label,
      });
      const attached = await onAttachCategory(ticket.id, category.id);
      if (attached) setNewCategoryLabel("");
    } catch (error) {
      setCategoryCreateError(
        error instanceof Error
          ? error.message
          : "Não foi possível criar e vincular a categoria.",
      );
    } finally {
      setCreatingCategory(false);
    }
  };

  return (
    <section
      aria-label="Classificação do atendimento"
      className="border-b border-border px-3.5 py-4"
      ref={sectionRef}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          Classificação por categoria
        </h3>
        {canManageCategories && onOpenCategoryCatalog ? (
          <Button
            className="shrink-0 gap-1.5"
            onClick={onOpenCategoryCatalog}
            size="sm"
            type="button"
            variant="outline"
          >
            <Tag size={13} />
            Ver catálogo
          </Button>
        ) : !canManageCategories ? (
          <small className="text-xs text-muted-foreground">Somente leitura</small>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        {categoryFacetOrder.map((facet) => {
          const categories = assignedByFacet[facet];
          if (!categories.length) return null;
          return (
            <div className="grid min-w-0 grid-cols-[68px_minmax(0,1fr)] items-start gap-2" key={facet}>
              <small className="pt-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                {categoryFacetLabels[facet]}
              </small>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {categories.map((category) => (
                  <span
                    className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs text-foreground"
                    key={category.id}
                  >
                    <i
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      style={{ backgroundColor: category.color ?? undefined }}
                    />
                    <span className="break-words">{getCategoryName(category)}</span>
                    {onDetachCategory ? (
                      <Button
                        aria-label={`Remover categoria ${category.label}`}
                        className="-mr-1 size-[18px] shrink-0 rounded-sm p-0 text-muted-foreground hover:text-destructive"
                        disabled={mutationBusy}
                        onClick={(event) => {
                          event.preventDefault();
                          void onDetachCategory(ticket.id, category.id);
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <X size={10} />
                      </Button>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        {!ticket.categories.length ? (
          <small className="text-xs text-muted-foreground">Sem categorias confirmadas</small>
        ) : null}
      </div>
      {canManageCategories && onAttachCategory ? (
        <>
        <form className="mt-3 grid gap-2.5" onSubmit={submitAttach}>
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            <span id="ticket-category-combobox-label">Vincular categoria existente</span>
            <Combobox
              ariaLabelledBy="ticket-category-combobox-label"
              disabled={mutationBusy || !availableCategories.length}
              onValueChange={setSelectedCategoryId}
              options={categoryOptions}
              placeholder="Selecione uma categoria…"
              searchPlaceholder="Buscar por nome ou tipo…"
              emptyMessage="Nenhuma categoria encontrada."
              value={selectedCategoryId}
            />
          </label>
          <Button
            className="w-full"
            disabled={mutationBusy || !selectedCategoryId}
            size="sm"
            type="submit"
            variant="default"
          >
            {mutationBusy ? "Vinculando…" : "Vincular"}
          </Button>
          {!availableCategories.length ? (
            <small className="text-xs leading-relaxed text-muted-foreground">
              Não há outras categorias no catálogo. Crie em Categorias antes de vincular.
              {onOpenCategoryCatalog ? (
                <>
                  {" "}
                  <Button
                    className="h-auto p-0 align-baseline text-xs"
                    onClick={onOpenCategoryCatalog}
                    variant="link"
                    type="button"
                  >
                    Abrir catálogo
                  </Button>
                </>
              ) : null}
            </small>
          ) : null}
        </form>
        {onCreateCategory ? (
          <details className="group mt-3 rounded-lg border border-border bg-background">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-primary marker:hidden">
              <Plus size={13} /> Criar nova categoria
            </summary>
            <form className="grid gap-3 border-t border-border p-3" onSubmit={submitCreate}>
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                <span>Faceta</span>
                <Select
                  disabled={creatingCategory || mutationBusy}
                  onValueChange={(value) => setNewCategoryFacet(value as CategoryFacetType)}
                  value={newCategoryFacet}
                >
                  <SelectTrigger aria-label="Faceta da nova categoria" className="w-full text-xs" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                  {(Object.keys(categoryFacetLabels) as CategoryFacetType[]).map(
                    (facet) => (
                      <SelectItem key={facet} value={facet}>
                        {categoryFacetLabels[facet]}
                      </SelectItem>
                    ),
                  )}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                <span>Nome</span>
                <Input
                  disabled={creatingCategory || mutationBusy}
                  maxLength={120}
                  onChange={(event) => setNewCategoryLabel(event.target.value)}
                  placeholder="Ex.: Checkout"
                  value={newCategoryLabel}
                />
              </label>
              <Button
                className="w-full"
                disabled={creatingCategory || mutationBusy || !newCategoryLabel.trim()}
                type="submit"
                variant="default"
              >
                {creatingCategory ? "Criando…" : "Criar e vincular"}
              </Button>
              {categoryCreateError ? (
                <small className="text-xs text-destructive">{categoryCreateError}</small>
              ) : null}
            </form>
          </details>
        ) : null}
        </>
      ) : null}
    </section>
  );
}
