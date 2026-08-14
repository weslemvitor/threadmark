"use client";

import { Input } from "@/app/components/ui/input";
import { NativeSelect } from "@/app/components/ui/native-select";
import { Textarea } from "@/app/components/ui/textarea";
import { Button } from "@/app/components/ui/button";

import {
  Filter,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  DirectorySegment,
  DirectorySegmentInput,
  DirectorySnapshot,
} from "@/app/lib/types";
import {
  DirectoryDialog,
  DirectoryFieldHint,
  directoryInputClass,
  directoryLabelClass,
} from "./directory-dialog";

type SegmentFilter = DirectorySegmentInput["filters"][number];
type DirectoryField = DirectorySnapshot["fields"][number];
type DirectoryValue = SegmentFilter["value"];

type DirectorySegmentEditorProps = {
  saving: boolean;
  segment?: DirectorySegment | null;
  snapshot: DirectorySnapshot;
  onCancel: () => void;
  onDelete?: (id: string) => Promise<boolean>;
  onSave: (input: DirectorySegmentInput) => Promise<boolean>;
};

const OPERATOR_LABELS: Record<SegmentFilter["operator"], string> = {
  equals: "é igual a",
  not_equals: "é diferente de",
  contains: "contém",
  not_contains: "não contém",
  is_empty: "está vazio",
  is_not_empty: "não está vazio",
  greater_than: "é maior que",
  less_than: "é menor que",
};

function operatorsFor(field?: DirectoryField): SegmentFilter["operator"][] {
  if (!field) return ["equals"];
  if (field.type === "number" || field.type === "date") {
    return ["equals", "not_equals", "greater_than", "less_than", "is_empty", "is_not_empty"];
  }
  if (field.type === "text" || field.type === "url") {
    return ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty"];
  }
  if (field.type === "multi_select") {
    return ["contains", "not_contains", "is_empty", "is_not_empty"];
  }
  return ["equals", "not_equals", "is_empty", "is_not_empty"];
}

function valueRequired(operator: SegmentFilter["operator"]): boolean {
  return operator !== "is_empty" && operator !== "is_not_empty";
}

function filterValueAsString(value: DirectoryValue): string {
  if (Array.isArray(value)) return value[0] ?? "";
  if (value === null || value === undefined || typeof value === "boolean") return "";
  return String(value);
}

function toggleValue(current: string[], value: string, checked: boolean): string[] {
  if (checked) return current.includes(value) ? current : [...current, value];
  return current.filter((item) => item !== value);
}

export function DirectorySegmentEditor({
  saving,
  segment,
  snapshot,
  onCancel,
  onDelete,
  onSave,
}: DirectorySegmentEditorProps) {
  const activeTypes = useMemo(
    () => snapshot.recordTypes.filter((type) => !type.archivedAt),
    [snapshot.recordTypes],
  );
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [recordTypeId, setRecordTypeId] = useState(segment?.recordTypeId ?? "");
  const [match, setMatch] = useState<DirectorySegmentInput["match"]>(segment?.match ?? "all");
  const [filters, setFilters] = useState<SegmentFilter[]>(() => segment?.filters.map((filter) => ({ ...filter })) ?? []);
  const fields = useMemo(
    () => snapshot.fields.filter((field) => field.recordTypeId === recordTypeId && !field.archivedAt).sort((left, right) => left.position - right.position),
    [recordTypeId, snapshot.fields],
  );
  const valid = Boolean(
    name.trim() &&
      filters.every((filter) => {
        const field = fields.find((item) => item.id === filter.fieldId);
        if (!field) return false;
        if (!valueRequired(filter.operator)) return true;
        if (Array.isArray(filter.value)) return filter.value.length > 0;
        return filter.value !== null && filter.value !== undefined && filter.value !== "";
      }),
  );

  function changeRecordType(nextTypeId: string) {
    setRecordTypeId(nextTypeId);
    setFilters([]);
  }

  function addFilter() {
    const field = fields[0];
    if (!field) return;
    setFilters((current) => [...current, { fieldId: field.id, operator: operatorsFor(field)[0], value: null }]);
  }

  function updateFilter(index: number, update: Partial<SegmentFilter>) {
    setFilters((current) => current.map((filter, currentIndex) => currentIndex === index ? { ...filter, ...update } : filter));
  }

  return (
    <DirectoryDialog
      description="Segmentos são filtros salvos sobre registros. Eles se atualizam conforme os dados locais mudam."
      eyebrow={segment ? "Editar segmento" : "Filtro reutilizável"}
      icon={Filter}
      onClose={onCancel}
      saving={saving}
      title={segment ? `Editar ${segment.name}` : "Criar segmento"}
      widthClassName="sm:max-w-4xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || saving) return;
          void onSave({
            name: name.trim(),
            description: description.trim() || null,
            recordTypeId: recordTypeId || null,
            match,
            filters: filters.map((filter) => ({
              fieldId: filter.fieldId,
              operator: filter.operator,
              ...(valueRequired(filter.operator) ? { value: filter.value ?? null } : {}),
            })),
          }).then((saved) => {
            if (saved) onCancel();
          });
        }}
      >
        <div className="space-y-6 px-4 py-5 sm:px-6">
          <section className="rounded-2xl border border-border bg-muted p-4 sm:p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className={directoryLabelClass}>
                Nome do segmento
                <Input autoFocus className={directoryInputClass} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Operações da região Sul" required value={name} />
              </label>
              <label className={directoryLabelClass}>
                Tipo de registro
                <NativeSelect className={directoryInputClass} onChange={(event) => changeRecordType(event.target.value)} value={recordTypeId}>
                  <option value="">Todos os registros ativos</option>
                  {activeTypes.map((type) => <option key={type.id} value={type.id}>{type.pluralName}</option>)}
                </NativeSelect>
                <DirectoryFieldHint>Selecione um tipo para usar seus campos personalizados.</DirectoryFieldHint>
              </label>
              <label className={`${directoryLabelClass} md:col-span-2`}>
                Descrição
                <Textarea className={`${directoryInputClass} min-h-20 resize-y`} maxLength={1_000} onChange={(event) => setDescription(event.target.value)} placeholder="Explique quando este segmento é útil" value={description} />
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-semibold text-foreground">Critérios</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {filters.length ? "Defina como os filtros devem ser combinados." : "Sem critérios, o segmento inclui todos os registros do escopo."}
                </p>
              </div>
              <Button disabled={!fields.length} onClick={addFilter} type="button" variant="outline"><Plus size={15} /> Adicionar critério</Button>
            </div>

            {filters.length > 1 ? (
              <fieldset className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted p-2">
                <legend className="sr-only">Combinação dos critérios</legend>
                <span className="px-2 text-xs font-semibold text-muted-foreground">Incluir quando</span>
                {(["all", "any"] as const).map((value) => (
                  <label className={`cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold transition ${match === value ? "bg-card text-primary shadow-sm" : "text-muted-foreground"}`} key={value}>
                    <Input checked={match === value} className="sr-only" onChange={() => setMatch(value)} type="radio" />
                    {value === "all" ? "todos forem verdadeiros" : "qualquer um for verdadeiro"}
                  </label>
                ))}
              </fieldset>
            ) : null}

            <div className="mt-4 grid gap-3">
              {filters.map((filter, index) => {
                const field = fields.find((item) => item.id === filter.fieldId);
                const operators = operatorsFor(field);
                return (
                  <div className="grid gap-3 rounded-xl border border-border bg-muted p-3 md:grid-cols-[minmax(150px,1fr)_minmax(145px,0.8fr)_minmax(160px,1fr)_40px] md:items-end" key={`${index}-${filter.fieldId}`}>
                    <label className={directoryLabelClass}>Campo<NativeSelect className={directoryInputClass} onChange={(event) => { const nextField = fields.find((item) => item.id === event.target.value); updateFilter(index, { fieldId: event.target.value, operator: operatorsFor(nextField)[0], value: null }); }} value={filter.fieldId}>{fields.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</NativeSelect></label>
                    <label className={directoryLabelClass}>Condição<NativeSelect className={directoryInputClass} onChange={(event) => updateFilter(index, { operator: event.target.value as SegmentFilter["operator"], value: null })} value={filter.operator}>{operators.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}</NativeSelect></label>
                    <SegmentFilterValue field={field} filter={filter} records={snapshot.records} onChange={(value) => updateFilter(index, { value })} />
                    <Button aria-label={`Remover critério ${index + 1}`} className="size-10" onClick={() => setFilters((current) => current.filter((_, currentIndex) => currentIndex !== index))} size="icon" type="button" variant="destructive"><Trash2 size={15} /></Button>
                  </div>
                );
              })}
              {!filters.length ? (
                <div className="rounded-xl border border-dashed border-border bg-muted px-4 py-8 text-center">
                  <Filter className="mx-auto text-muted-foreground" size={22} />
                  <strong className="mt-3 block text-sm text-foreground">Segmento sem critérios</strong>
                  <p className="mt-1 text-xs text-muted-foreground">{recordTypeId ? (fields.length ? "Adicione um critério ou salve para incluir todos deste tipo." : "Esse tipo ainda não possui campos personalizados.") : "Salve para incluir todos os registros ativos ou escolha um tipo."}</p>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <footer className="flex flex-col-reverse gap-3 border-t border-border bg-muted px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            {segment && onDelete ? (
              <Button
                disabled={saving}
                onClick={() => {
                  if (!window.confirm(`Excluir o segmento “${segment.name}”? Os registros não serão alterados.`)) return;
                  void onDelete(segment.id).then((deleted) => { if (deleted) onCancel(); });
                }}
                type="button"
                variant="destructive"
              >
                <Trash2 size={15} /> Excluir segmento
              </Button>
            ) : <span className="text-xs text-muted-foreground">O segmento será calculado usando o SQLite local.</span>}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button disabled={saving} onClick={onCancel} type="button" variant="outline">Cancelar</Button>
            <Button disabled={!valid || saving} type="submit">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} {saving ? "Salvando…" : "Salvar segmento"}</Button>
          </div>
        </footer>
      </form>
    </DirectoryDialog>
  );
}

function SegmentFilterValue({
  field,
  filter,
  records,
  onChange,
}: {
  field?: DirectoryField;
  filter: SegmentFilter;
  records: DirectorySnapshot["records"];
  onChange: (value: DirectoryValue) => void;
}) {
  if (!valueRequired(filter.operator)) {
    return <div className="flex h-10 items-center text-xs text-muted-foreground">Sem valor necessário</div>;
  }
  if (!field) return <div />;

  if (field.type === "boolean") {
    return <label className={directoryLabelClass}>Valor<NativeSelect className={directoryInputClass} onChange={(event) => onChange(event.target.value === "true")} value={String(filter.value ?? "")}><option value="">Selecione</option><option value="true">Sim</option><option value="false">Não</option></NativeSelect></label>;
  }
  if (field.type === "select") {
    return <label className={directoryLabelClass}>Valor<NativeSelect className={directoryInputClass} onChange={(event) => onChange(event.target.value || null)} value={filterValueAsString(filter.value)}><option value="">Selecione</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</NativeSelect></label>;
  }
  if (field.type === "multi_select") {
    const selected = Array.isArray(filter.value) ? filter.value : filter.value ? [String(filter.value)] : [];
    return (
      <fieldset className="min-w-0">
        <legend className="text-sm font-semibold text-foreground">Valor</legend>
        <div className="mt-1.5 flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card p-1.5">
          {field.options.map((option) => <label className={`cursor-pointer rounded-lg px-2 py-1.5 text-xs font-semibold ${selected.includes(option) ? "bg-accent text-primary" : "text-muted-foreground hover:bg-muted"}`} key={option}><Input checked={selected.includes(option)} className="sr-only" onChange={(event) => onChange(toggleValue(selected, option, event.target.checked))} type="checkbox" />{option}</label>)}
        </div>
      </fieldset>
    );
  }
  if (field.type === "relation") {
    const candidates = records.filter((record) => !record.archivedAt && (!field.relationRecordTypeId || record.typeId === field.relationRecordTypeId));
    return <label className={directoryLabelClass}>Valor<NativeSelect className={directoryInputClass} onChange={(event) => onChange(event.target.value || null)} value={filterValueAsString(filter.value)}><option value="">Selecione</option>{candidates.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}</NativeSelect></label>;
  }
  return <label className={directoryLabelClass}>Valor<Input className={directoryInputClass} onChange={(event) => onChange(field.type === "number" ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value || null)} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"} value={filterValueAsString(filter.value)} /></label>;
}

export { OPERATOR_LABELS };
