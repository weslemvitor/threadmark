"use client";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { NativeSelect } from "@/app/components/ui/native-select";

import {
  Braces,
  CircleDot,
  Hash,
  Link2,
  ListChecks,
  LoaderCircle,
  Palette,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  ToggleLeft,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  DirectoryFieldDefinitionInput,
  DirectoryRecordType,
  DirectoryRecordTypeInput,
  DirectorySnapshot,
} from "@/app/lib/types";
import {
  DirectoryDialog,
  DirectoryFieldHint,
  directoryInputClass,
  directoryLabelClass,
} from "./directory-dialog";

type DirectoryField = DirectorySnapshot["fields"][number];

type DirectorySchemaEditorProps = {
  saving: boolean;
  snapshot: DirectorySnapshot;
  onCancel: () => void;
  onCreateField: (input: DirectoryFieldDefinitionInput) => Promise<boolean>;
  onCreateRecordType: (input: DirectoryRecordTypeInput) => Promise<boolean>;
  onUpdateField: (id: string, input: DirectoryFieldDefinitionInput) => Promise<boolean>;
  onUpdateRecordType: (id: string, input: DirectoryRecordTypeInput) => Promise<boolean>;
};

type TypeDraft = {
  id: string | null;
  name: string;
  pluralName: string;
  slug: string;
  description: string;
  color: string;
};

type FieldDraft = {
  id: string | null;
  recordTypeId: string;
  key: string;
  label: string;
  type: DirectoryField["type"];
  required: boolean;
  optionsText: string;
  relationRecordTypeId: string;
  position: number;
};

const FIELD_TYPE_OPTIONS: Array<{ value: DirectoryField["type"]; label: string }> = [
  { value: "text", label: "Texto" },
  { value: "number", label: "Número" },
  { value: "boolean", label: "Sim ou não" },
  { value: "date", label: "Data" },
  { value: "url", label: "URL" },
  { value: "select", label: "Seleção única" },
  { value: "multi_select", label: "Seleção múltipla" },
  { value: "relation", label: "Relação com registro" },
];

function blankTypeDraft(): TypeDraft {
  return { id: null, name: "", pluralName: "", slug: "", description: "", color: "#6558dd" };
}

function typeDraft(recordType: DirectoryRecordType): TypeDraft {
  return {
    id: recordType.id,
    name: recordType.name,
    pluralName: recordType.pluralName,
    slug: recordType.slug,
    description: recordType.description ?? "",
    color: recordType.color ?? "#6558dd",
  };
}

function blankFieldDraft(recordTypeId: string, position: number): FieldDraft {
  return {
    id: null,
    recordTypeId,
    key: "",
    label: "",
    type: "text",
    required: false,
    optionsText: "",
    relationRecordTypeId: "",
    position,
  };
}

function fieldDraft(field: DirectoryField): FieldDraft {
  return {
    id: field.id,
    recordTypeId: field.recordTypeId,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    optionsText: field.options.join("\n"),
    relationRecordTypeId: field.relationRecordTypeId ?? "",
    position: field.position,
  };
}

function fieldTypeLabel(type: DirectoryField["type"]): string {
  return FIELD_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export function DirectorySchemaEditor({
  saving,
  snapshot,
  onCancel,
  onCreateField,
  onCreateRecordType,
  onUpdateField,
  onUpdateRecordType,
}: DirectorySchemaEditorProps) {
  const activeTypes = useMemo(
    () => snapshot.recordTypes.filter((type) => !type.archivedAt),
    [snapshot.recordTypes],
  );
  const [selectedTypeId, setSelectedTypeId] = useState(activeTypes[0]?.id ?? "");
  const [editingType, setEditingType] = useState<TypeDraft | null>(null);
  const [editingField, setEditingField] = useState<FieldDraft | null>(null);
  const selectedType = activeTypes.find((type) => type.id === selectedTypeId) ?? null;
  const selectedFields = snapshot.fields
    .filter((field) => field.recordTypeId === selectedTypeId && !field.archivedAt)
    .sort((left, right) => left.position - right.position);

  function beginNewField() {
    if (!selectedTypeId) return;
    const nextPosition = (selectedFields.at(-1)?.position ?? -1) + 1;
    setEditingField(blankFieldDraft(selectedTypeId, nextPosition));
  }

  return (
    <DirectoryDialog
      description="Crie sua própria estrutura. Uma instalação nova não pressupõe nenhum modelo comercial."
      eyebrow="Modelo de dados"
      icon={SlidersHorizontal}
      onClose={onCancel}
      saving={saving}
      title="Tipos e campos personalizados"
      widthClassName="sm:max-w-6xl"
    >
      <div className="grid min-h-[560px] lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-border bg-muted p-4 lg:border-r lg:border-b-0 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-foreground">Tipos de registro</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Organize apenas o que sua equipe precisa.</p>
            </div>
            <Button
              aria-label="Criar tipo de registro"
              className="rounded-xl"
              onClick={() => setEditingType(blankTypeDraft())}
              size="icon"
              type="button"
              variant="default"
            >
              <Plus size={17} />
            </Button>
          </div>

          <div className="mt-4 grid gap-2">
            {activeTypes.map((type) => {
              const selected = type.id === selectedTypeId;
              return (
                <div className={`group flex items-center gap-2 rounded-xl border p-2 transition ${selected ? "border-primary/30 bg-card shadow-sm" : "border-transparent hover:border-border hover:bg-card"}`} key={type.id}>
                  <Button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => { setSelectedTypeId(type.id); setEditingField(null); }} size="unstyled" type="button" variant="unstyled">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundColor: type.color ?? "#6558dd" }}>
                      {type.name.slice(0, 1).toLocaleUpperCase("pt-BR")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm text-foreground">{type.pluralName}</strong>
                      <small className="mt-0.5 block text-xs text-muted-foreground">{type.recordCount} registros{type.system ? " · sistema" : ""}</small>
                    </span>
                  </Button>
                  <Button aria-label={`Editar tipo ${type.name}`} className="opacity-70 group-hover:opacity-100" onClick={() => setEditingType(typeDraft(type))} size="icon-sm" type="button" variant="ghost">
                    <Pencil size={14} />
                  </Button>
                </div>
              );
            })}
            {!activeTypes.length ? (
              <div className="rounded-2xl border border-dashed border-border bg-card px-4 py-8 text-center">
                <CircleDot className="mx-auto text-muted-foreground" size={22} />
                <strong className="mt-3 block text-sm text-foreground">Diretório sem classificação</strong>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Isso é válido. Grupos e pessoas continuam disponíveis sem tipos adicionais.</p>
                <Button className="mt-4" onClick={() => setEditingType(blankTypeDraft())} type="button" variant="outline"><Plus size={15} /> Criar primeiro tipo</Button>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="min-w-0 p-4 sm:p-6">
          {editingType ? (
            <TypeForm
              draft={editingType}
              saving={saving}
              onCancel={() => setEditingType(null)}
              onChange={setEditingType}
              onSave={async (draft) => {
                const input: DirectoryRecordTypeInput = {
                  name: draft.name.trim(),
                  pluralName: draft.pluralName.trim(),
                  slug: draft.slug.trim() || undefined,
                  description: draft.description.trim() || null,
                  color: draft.color || null,
                };
                const saved = draft.id
                  ? await onUpdateRecordType(draft.id, input)
                  : await onCreateRecordType(input);
                if (saved) setEditingType(null);
              }}
            />
          ) : editingField ? (
            <FieldForm
              draft={editingField}
              recordTypes={activeTypes}
              saving={saving}
              onCancel={() => setEditingField(null)}
              onChange={setEditingField}
              onSave={async (draft) => {
                const options = draft.optionsText
                  .split(/\r?\n|,/)
                  .map((option) => option.trim())
                  .filter((option, index, values) => Boolean(option) && values.indexOf(option) === index);
                const input: DirectoryFieldDefinitionInput = {
                  recordTypeId: draft.recordTypeId,
                  key: draft.key.trim() || undefined,
                  label: draft.label.trim(),
                  type: draft.type,
                  required: draft.required,
                  options: draft.type === "select" || draft.type === "multi_select" ? options : [],
                  relationRecordTypeId: draft.type === "relation" ? draft.relationRecordTypeId || null : null,
                  position: draft.position,
                };
                const saved = draft.id
                  ? await onUpdateField(draft.id, input)
                  : await onCreateField(input);
                if (saved) setEditingField(null);
              }}
            />
          ) : selectedType ? (
            <>
              <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-lg font-bold text-white" style={{ backgroundColor: selectedType.color ?? "#6558dd" }}>
                    {selectedType.name.slice(0, 1).toLocaleUpperCase("pt-BR")}
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-foreground">{selectedType.pluralName}</h3>
                      {selectedType.system ? <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">Compatibilidade do sistema</span> : null}
                    </div>
                    <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">{selectedType.description || `Campos disponíveis em cada registro do tipo ${selectedType.name}.`}</p>
                  </div>
                </div>
                <Button onClick={beginNewField} type="button"><Plus size={16} /> Novo campo</Button>
              </header>

              <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
                <div className="grid grid-cols-[minmax(0,1fr)_110px_76px_38px] gap-3 border-b border-border bg-muted px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
                  <span>Campo</span><span>Tipo</span><span>Regra</span><span />
                </div>
                {selectedFields.map((field) => (
                  <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_110px_76px_38px] items-center gap-3 border-b border-border/70 px-4 py-3 last:border-b-0" key={field.id}>
                    <span className="min-w-0">
                      <strong className="block truncate text-sm text-foreground">{field.label}</strong>
                      <small className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{field.key}</small>
                    </span>
                    <span className="text-xs text-muted-foreground">{fieldTypeLabel(field.type)}</span>
                    <span className="text-xs text-muted-foreground">{field.required ? "Obrigatório" : "Opcional"}</span>
                    <Button aria-label={`Editar campo ${field.label}`} onClick={() => setEditingField(fieldDraft(field))} size="icon-sm" type="button" variant="ghost"><Pencil size={14} /></Button>
                  </div>
                ))}
                {!selectedFields.length ? (
                  <div className="px-5 py-12 text-center">
                    <Braces className="mx-auto text-muted-foreground" size={24} />
                    <strong className="mt-3 block text-sm text-foreground">Nenhum campo personalizado</strong>
                    <p className="mt-1 text-xs text-muted-foreground">Todo registro já possui nome e descrição. Adicione somente informações úteis.</p>
                    <Button className="mt-4" onClick={beginNewField} type="button" variant="outline"><Plus size={15} /> Adicionar campo</Button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid min-h-[440px] place-items-center text-center">
              <div className="max-w-sm"><Braces className="mx-auto text-muted-foreground" size={26} /><h3 className="mt-3 font-semibold text-foreground">Crie um tipo quando precisar classificar</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Enquanto isso, o Threadmark funciona apenas com os grupos e pessoas sincronizados.</p></div>
            </div>
          )}
        </div>
      </div>
    </DirectoryDialog>
  );
}

function TypeForm({
  draft,
  saving,
  onCancel,
  onChange,
  onSave,
}: {
  draft: TypeDraft;
  saving: boolean;
  onCancel: () => void;
  onChange: (draft: TypeDraft) => void;
  onSave: (draft: TypeDraft) => Promise<void>;
}) {
  const valid = Boolean(draft.name.trim() && draft.pluralName.trim());
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (valid && !saving) void onSave(draft); }}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-primary"><Palette size={18} /></span>
        <div><h3 className="font-semibold text-foreground">{draft.id ? "Editar tipo" : "Novo tipo de registro"}</h3><p className="mt-1 text-sm leading-5 text-muted-foreground">Use nomes que façam sentido para esta instalação.</p></div>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className={directoryLabelClass}>Nome no singular<Input autoFocus className={directoryInputClass} maxLength={80} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="Ex.: Parceiro" required value={draft.name} /></label>
        <label className={directoryLabelClass}>Nome no plural<Input className={directoryInputClass} maxLength={80} onChange={(event) => onChange({ ...draft, pluralName: event.target.value })} placeholder="Ex.: Parceiros" required value={draft.pluralName} /></label>
        <label className={directoryLabelClass}>Identificador técnico<Input className={directoryInputClass} maxLength={80} onChange={(event) => onChange({ ...draft, slug: event.target.value })} pattern="[a-z0-9_-]*" placeholder="Gerado automaticamente" value={draft.slug} /><DirectoryFieldHint>Use letras minúsculas, números, hífen ou underline.</DirectoryFieldHint></label>
        <label className={directoryLabelClass}>Cor<Input className={`${directoryInputClass} h-[42px] p-1.5`} onChange={(event) => onChange({ ...draft, color: event.target.value })} type="color" value={draft.color} /></label>
        <label className={`${directoryLabelClass} md:col-span-2`}>Descrição<Textarea className={`${directoryInputClass} min-h-24 resize-y`} maxLength={1_000} onChange={(event) => onChange({ ...draft, description: event.target.value })} placeholder="Quando este tipo deve ser usado?" value={draft.description} /></label>
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button disabled={saving} onClick={onCancel} type="button" variant="outline">Cancelar</Button><Button disabled={!valid || saving} type="submit">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} {saving ? "Salvando…" : "Salvar tipo"}</Button></div>
    </form>
  );
}

function FieldForm({
  draft,
  recordTypes,
  saving,
  onCancel,
  onChange,
  onSave,
}: {
  draft: FieldDraft;
  recordTypes: DirectoryRecordType[];
  saving: boolean;
  onCancel: () => void;
  onChange: (draft: FieldDraft) => void;
  onSave: (draft: FieldDraft) => Promise<void>;
}) {
  const needsOptions = draft.type === "select" || draft.type === "multi_select";
  const valid = Boolean(draft.label.trim() && (!needsOptions || draft.optionsText.split(/\r?\n|,/).some((option) => option.trim())) && (draft.type !== "relation" || draft.relationRecordTypeId));
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (valid && !saving) void onSave(draft); }}>
      <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-primary"><Braces size={18} /></span><div><h3 className="font-semibold text-foreground">{draft.id ? "Editar campo" : "Novo campo personalizado"}</h3><p className="mt-1 text-sm leading-5 text-muted-foreground">Escolha um formato que mantenha os dados consistentes.</p></div></div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className={directoryLabelClass}>Rótulo<Input autoFocus className={directoryInputClass} maxLength={100} onChange={(event) => onChange({ ...draft, label: event.target.value })} placeholder="Ex.: Região" required value={draft.label} /></label>
        <label className={directoryLabelClass}>Chave técnica<Input className={directoryInputClass} maxLength={100} onChange={(event) => onChange({ ...draft, key: event.target.value })} pattern="[a-z0-9_-]*" placeholder="Gerada automaticamente" value={draft.key} /></label>
        <label className={directoryLabelClass}>Tipo<NativeSelect className={directoryInputClass} onChange={(event) => onChange({ ...draft, type: event.target.value as DirectoryField["type"] })} value={draft.type}>{FIELD_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect></label>
        <label className={directoryLabelClass}>Ordem<Input className={directoryInputClass} min={0} onChange={(event) => onChange({ ...draft, position: Number(event.target.value) })} type="number" value={draft.position} /></label>
        {needsOptions ? <label className={`${directoryLabelClass} md:col-span-2`}>Opções<Textarea className={`${directoryInputClass} min-h-28 resize-y`} onChange={(event) => onChange({ ...draft, optionsText: event.target.value })} placeholder={"Uma opção por linha\nEx.: Sul\nSudeste"} required value={draft.optionsText} /><DirectoryFieldHint>Valores duplicados serão removidos ao salvar.</DirectoryFieldHint></label> : null}
        {draft.type === "relation" ? <label className={`${directoryLabelClass} md:col-span-2`}>Relacionar com<NativeSelect className={directoryInputClass} onChange={(event) => onChange({ ...draft, relationRecordTypeId: event.target.value })} required value={draft.relationRecordTypeId}><option value="">Selecione o tipo de destino</option>{recordTypes.map((type) => <option key={type.id} value={type.id}>{type.pluralName}</option>)}</NativeSelect></label> : null}
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted px-3.5 text-sm font-semibold text-foreground md:col-span-2"><Input checked={draft.required} className="h-4 w-4 accent-primary" onChange={(event) => onChange({ ...draft, required: event.target.checked })} type="checkbox" /><ToggleLeft size={17} className="text-primary" /> Preenchimento obrigatório</label>
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button disabled={saving} onClick={onCancel} type="button" variant="outline">Cancelar</Button><Button disabled={!valid || saving} type="submit">{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />} {saving ? "Salvando…" : "Salvar campo"}</Button></div>
    </form>
  );
}

export function DirectoryFieldTypeIcon({ type }: { type: DirectoryField["type"] }) {
  if (type === "number") return <Hash size={15} />;
  if (type === "boolean") return <ToggleLeft size={15} />;
  if (type === "select" || type === "multi_select") return <ListChecks size={15} />;
  if (type === "relation") return <Link2 size={15} />;
  return <Braces size={15} />;
}
