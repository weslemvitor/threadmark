"use client";

import { NativeSelect } from "@/app/components/ui/native-select";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Button } from "@/app/components/ui/button";

import {
  Boxes,
  Building2,
  Check,
  Link2,
  LoaderCircle,
  Save,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  DirectoryRecord,
  DirectoryRecordInput,
  DirectorySnapshot,
} from "@/app/lib/types";
import {
  DirectoryDialog,
  DirectoryFieldHint,
  directoryInputClass,
  directoryLabelClass,
} from "./directory-dialog";

type DirectoryValue = DirectoryRecord["values"][string];
type DirectoryField = DirectorySnapshot["fields"][number];

type DirectoryRecordEditorProps = {
  record?: DirectoryRecord | null;
  saving: boolean;
  snapshot: DirectorySnapshot;
  onCancel: () => void;
  onSave: (input: DirectoryRecordInput) => Promise<boolean>;
};

function hasRequiredValue(value: DirectoryValue): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return Boolean(value.trim());
  return true;
}

function fieldValueAsString(value: DirectoryValue): string {
  if (Array.isArray(value)) return value[0] ?? "";
  if (typeof value === "boolean" || value === null || value === undefined) return "";
  return String(value);
}

function toggleMembership(current: string[], id: string, checked: boolean): string[] {
  if (checked) return current.includes(id) ? current : [...current, id];
  return current.filter((item) => item !== id);
}

export function DirectoryRecordEditor({
  record,
  saving,
  snapshot,
  onCancel,
  onSave,
}: DirectoryRecordEditorProps) {
  const activeTypes = useMemo(
    () => snapshot.recordTypes.filter((type) => !type.archivedAt),
    [snapshot.recordTypes],
  );
  const [typeId, setTypeId] = useState(record?.typeId ?? activeTypes[0]?.id ?? "");
  const [name, setName] = useState(record?.name ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [values, setValues] = useState<Record<string, DirectoryValue>>(
    record ? { ...record.values } : {},
  );
  const [groupIds, setGroupIds] = useState(record?.groupIds ?? []);
  const [personIds, setPersonIds] = useState(record?.personIds ?? []);
  const [relatedRecordIds, setRelatedRecordIds] = useState(record?.relatedRecordIds ?? []);

  const fields = useMemo(
    () =>
      snapshot.fields
        .filter((field) => field.recordTypeId === typeId && !field.archivedAt)
        .sort((left, right) => left.position - right.position),
    [snapshot.fields, typeId],
  );
  const valid = Boolean(
    typeId &&
      name.trim() &&
      fields.every((field) => !field.required || hasRequiredValue(values[field.id])),
  );

  function changeType(nextTypeId: string) {
    if (nextTypeId === typeId) return;
    setTypeId(nextTypeId);
    setValues({});
  }

  return (
    <DirectoryDialog
      description="Classifique um grupo ou uma pessoa somente quando essa organização fizer sentido para sua operação."
      eyebrow={record ? "Editar registro" : "Organização opcional"}
      icon={Building2}
      onClose={onCancel}
      saving={saving}
      title={record ? `Editar ${record.name}` : "Criar registro no diretório"}
      widthClassName="sm:max-w-5xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || saving) return;
          void onSave({
            typeId,
            name: name.trim(),
            description: description.trim() || null,
            values,
            groupIds,
            personIds,
            relatedRecordIds,
          }).then((saved) => {
            if (saved) onCancel();
          });
        }}
      >
        <div className="space-y-6 px-4 py-5 sm:px-6">
          <section className="rounded-2xl border border-border bg-muted p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-card text-primary shadow-sm">
                <Boxes size={17} />
              </span>
              <div>
                <h3 className="font-semibold text-foreground">Identidade do registro</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  O tipo e os campos são definidos por você, sem pressupor cliente, agência ou ecommerce.
                </p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className={directoryLabelClass}>
                Tipo do registro
                <NativeSelect
                  className={directoryInputClass}
                  disabled={Boolean(record)}
                  onChange={(event) => changeType(event.target.value)}
                  required
                  value={typeId}
                >
                  <option disabled value="">Selecione um tipo</option>
                  {activeTypes.map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </NativeSelect>
                {record ? <DirectoryFieldHint>O tipo permanece fixo para preservar os campos já preenchidos.</DirectoryFieldHint> : null}
              </label>
              <label className={directoryLabelClass}>
                Nome
                <Input
                  autoFocus
                  className={directoryInputClass}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ex.: Operação Sul"
                  required
                  value={name}
                />
              </label>
              <label className={`${directoryLabelClass} md:col-span-2`}>
                Descrição interna
                <Textarea
                  className={`${directoryInputClass} min-h-24 resize-y`}
                  maxLength={4_000}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Contexto útil sobre este registro"
                  value={description}
                />
              </label>
            </div>
          </section>

          {fields.length ? (
            <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="mb-4">
                <h3 className="font-semibold text-foreground">Campos personalizados</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">Informações adicionais definidas para este tipo de registro.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {fields.map((field) => (
                  <RecordField
                    field={field}
                    key={field.id}
                    records={snapshot.records}
                    recordTypes={snapshot.recordTypes}
                    value={values[field.id] ?? null}
                    onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                <Link2 size={17} />
              </span>
              <div>
                <h3 className="font-semibold text-foreground">Vínculos opcionais</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Relacione grupos, pessoas ou outros registros. Nada é inferido apenas pela participação em um grupo.
                </p>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <AssociationChecklist
                emptyLabel="Nenhum grupo disponível"
                icon={UsersRound}
                items={snapshot.groups.map((group) => ({ id: group.id, label: group.subject, meta: `${group.participantCount} participantes` }))}
                label="Grupos"
                selectedIds={groupIds}
                onChange={setGroupIds}
              />
              <AssociationChecklist
                emptyLabel="Nenhuma pessoa disponível"
                icon={UserRound}
                items={snapshot.people.map((person) => ({ id: person.id, label: person.displayName, meta: person.phoneE164 ?? "Sem telefone" }))}
                label="Pessoas"
                selectedIds={personIds}
                onChange={setPersonIds}
              />
              <AssociationChecklist
                emptyLabel="Nenhum outro registro disponível"
                icon={Building2}
                items={snapshot.records
                  .filter((item) => !item.archivedAt && item.id !== record?.id)
                  .map((item) => ({
                    id: item.id,
                    label: item.name,
                    meta: snapshot.recordTypes.find((type) => type.id === item.typeId)?.name ?? "Registro",
                  }))}
                label="Outros registros"
                selectedIds={relatedRecordIds}
                onChange={setRelatedRecordIds}
              />
            </div>
          </section>
        </div>

        <footer className="flex flex-col-reverse gap-3 border-t border-border bg-muted px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="text-xs leading-5 text-muted-foreground">Conversas, mensagens e tickets existentes não são alterados.</span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button disabled={saving} onClick={onCancel} type="button" variant="outline">Cancelar</Button>
            <Button disabled={!valid || saving} type="submit">
              {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
              {saving ? "Salvando…" : "Salvar registro"}
            </Button>
          </div>
        </footer>
      </form>
    </DirectoryDialog>
  );
}

function RecordField({
  field,
  records,
  recordTypes,
  value,
  onChange,
}: {
  field: DirectoryField;
  records: DirectorySnapshot["records"];
  recordTypes: DirectorySnapshot["recordTypes"];
  value: DirectoryValue;
  onChange: (value: DirectoryValue) => void;
}) {
  const label = `${field.label}${field.required ? " *" : ""}`;

  if (field.type === "boolean") {
    return (
      <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted px-3.5 text-sm font-semibold text-foreground">
        <Input
          checked={value === true}
          className="h-4 w-4 accent-primary"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {field.label}
      </label>
    );
  }

  if (field.type === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="min-w-0 rounded-xl border border-border bg-muted p-3 md:col-span-2">
        <legend className="px-1 text-sm font-semibold text-foreground">{label}</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {field.options.map((option) => {
            const checked = selected.includes(option);
            return (
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition ${checked ? "border-primary/30 bg-accent text-primary" : "border-border bg-card text-muted-foreground"}`} key={option}>
                <Input
                  checked={checked}
                  className="sr-only"
                  onChange={(event) => onChange(toggleMembership(selected, option, event.target.checked))}
                  type="checkbox"
                />
                {checked ? <Check size={13} /> : null}
                {option}
              </label>
            );
          })}
          {!field.options.length ? <span className="text-xs text-muted-foreground">Adicione opções na configuração do tipo.</span> : null}
        </div>
      </fieldset>
    );
  }

  if (field.type === "select") {
    return (
      <label className={directoryLabelClass}>
        {label}
        <NativeSelect className={directoryInputClass} onChange={(event) => onChange(event.target.value || null)} required={field.required} value={fieldValueAsString(value)}>
          <option value="">Selecione</option>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </NativeSelect>
      </label>
    );
  }

  if (field.type === "relation") {
    const targetType = recordTypes.find((type) => type.id === field.relationRecordTypeId);
    const candidates = records.filter((record) => !record.archivedAt && (!field.relationRecordTypeId || record.typeId === field.relationRecordTypeId));
    return (
      <label className={directoryLabelClass}>
        {label}
        <NativeSelect className={directoryInputClass} onChange={(event) => onChange(event.target.value || null)} required={field.required} value={fieldValueAsString(value)}>
          <option value="">Selecione {targetType?.name.toLocaleLowerCase("pt-BR") ?? "um registro"}</option>
          {candidates.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}
        </NativeSelect>
      </label>
    );
  }

  return (
    <label className={directoryLabelClass}>
      {label}
      <Input
        className={directoryInputClass}
        maxLength={field.type === "number" ? undefined : 2_000}
        onChange={(event) => {
          if (field.type !== "number") {
            onChange(event.target.value || null);
            return;
          }
          onChange(event.target.value === "" ? null : Number(event.target.value));
        }}
        placeholder={field.type === "url" ? "https://…" : undefined}
        required={field.required}
        type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
        value={fieldValueAsString(value)}
      />
    </label>
  );
}

function AssociationChecklist({
  emptyLabel,
  icon: Icon,
  items,
  label,
  selectedIds,
  onChange,
}: {
  emptyLabel: string;
  icon: typeof UsersRound;
  items: Array<{ id: string; label: string; meta: string }>;
  label: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return items;
    return items.filter((item) => `${item.label} ${item.meta}`.toLocaleLowerCase("pt-BR").includes(normalized));
  }, [items, query]);

  return (
    <fieldset className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted">
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2.5">
        <Icon className="text-primary" size={15} />
        <strong className="min-w-0 flex-1 text-sm text-foreground">{label}</strong>
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">{selectedIds.length}</span>
      </div>
      <label className="m-2 flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-muted-foreground">
        <Search size={14} />
        <span className="sr-only">Buscar em {label}</span>
        <Input className="h-9 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" type="search" value={query} />
      </label>
      <div className="max-h-48 overflow-y-auto p-2 pt-0">
        {filtered.map((item) => (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 transition hover:bg-card" key={item.id}>
            <Input
              checked={selectedIds.includes(item.id)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              onChange={(event) => onChange(toggleMembership(selectedIds, item.id, event.target.checked))}
              type="checkbox"
            />
            <span className="min-w-0">
              <strong className="block truncate text-xs text-foreground">{item.label}</strong>
              <small className="mt-0.5 block truncate text-xs text-muted-foreground">{item.meta}</small>
            </span>
          </label>
        ))}
        {!filtered.length ? <p className="px-2 py-5 text-center text-xs text-muted-foreground">{items.length ? "Nenhum resultado" : emptyLabel}</p> : null}
      </div>
    </fieldset>
  );
}
