"use client";

import { Archive, ArrowRight, Boxes, Building2, CheckCircle2, CircleSlash, Filter, FolderCog, Link2, MessageSquareText, Pencil, Plus, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeTime, getDirectoryGroupPresentation, getDirectoryPersonPresentation } from "@/app/lib/format";
import type { DirectoryRecord, DirectorySegment, DirectorySegmentInput, DirectorySnapshot } from "@/app/lib/types";
import { OPERATOR_LABELS } from "./directory-segment-editor";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { NativeSelect } from "@/app/components/ui/native-select";
import { EmptyState } from "@/app/components/shared/ui-states";

type DirectoryGroup = DirectorySnapshot["groups"][number];
type DirectoryPerson = DirectorySnapshot["people"][number];
type DirectoryField = DirectorySnapshot["fields"][number];
type DirectoryValue = DirectoryRecord["values"][string];

function searchable(...values: unknown[]): string {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase("pt-BR");
}

function matchesQuery(query: string, ...values: unknown[]): boolean {
  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  return !normalized || searchable(...values).includes(normalized);
}

export function GroupsView({
  groups,
  query,
  records,
  recordTypes,
}: {
  groups: DirectoryGroup[];
  query: string;
  records: DirectorySnapshot["records"];
  recordTypes: DirectorySnapshot["recordTypes"];
}) {
  const filtered = useMemo(() => groups.filter((group) => {
    const linked = records.filter((record) => group.linkedRecordIds.includes(record.id));
    return matchesQuery(query, group.subject, group.externalJid, linked.map((record) => record.name));
  }), [groups, query, records]);

  if (!filtered.length) return <ViewEmpty query={query} kind="grupo" />;

  return (
    <div className="p-4 sm:p-5">
      <ViewIntro icon={MessageSquareText} title={`${filtered.length} grupos`} description="Conversas coletivas sincronizadas do WhatsApp, sem exigir classificação comercial." />
      <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {filtered.map((group) => {
          const linkedRecords = records.filter((record) => group.linkedRecordIds.includes(record.id) && !record.archivedAt);
          const presentation = getDirectoryGroupPresentation(group);
          return (
            <article className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm" key={group.id}>
              <header className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><UsersRound size={18} /></span>
                <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold text-foreground" title={presentation.name}>{presentation.name}</h3><p className="mt-1 truncate text-xs text-muted-foreground" title={presentation.detail}>{presentation.detail}</p></div>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${group.monitored ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{group.monitored ? <CheckCircle2 size={11} /> : <CircleSlash size={11} />}{group.monitored ? "Monitorado" : "Pausado"}</span>
              </header>
              <dl className="mt-4 grid grid-cols-3 divide-x divide-border/70 rounded-xl bg-muted py-3 text-center">
                <Stat value={group.participantCount} label="participantes" />
                <Stat value={group.ticketCount} label="tickets" />
                <Stat value={group.openTicketCount} label="abertos" tone={group.openTicketCount ? "amber" : "neutral"} />
              </dl>
              <LinkedRecords records={linkedRecords} recordTypes={recordTypes} />
              <footer className="mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-xs text-muted-foreground"><span>Última atividade</span><strong className="font-semibold text-muted-foreground">{formatRelativeTime(group.lastActivityAt)}</strong></footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function PeopleView({
  people,
  query,
  records,
  recordTypes,
}: {
  people: DirectoryPerson[];
  query: string;
  records: DirectorySnapshot["records"];
  recordTypes: DirectorySnapshot["recordTypes"];
}) {
  const filtered = useMemo(() => people.filter((person) => {
    const linked = records.filter((record) => person.linkedRecordIds.includes(record.id));
    return matchesQuery(query, person.displayName, person.phoneE164, person.externalJid, linked.map((record) => record.name));
  }), [people, query, records]);

  if (!filtered.length) return <ViewEmpty query={query} kind="pessoa" />;

  return (
    <div className="p-4 sm:p-5">
      <ViewIntro icon={UserRound} title={`${filtered.length} pessoas`} description="Participantes observados nos grupos. Fazer parte de um grupo não cria vínculo organizacional automaticamente." />
      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-[minmax(180px,1.2fr)_minmax(150px,0.9fr)_90px_minmax(170px,1fr)_120px] gap-3 border-b border-border bg-muted px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground lg:grid"><span>Pessoa</span><span>Telefone</span><span>Grupos</span><span>Vínculos</span><span>Atividade</span></div>
        <div className="divide-y divide-border/70">
          {filtered.map((person) => {
            const linkedRecords = records.filter((record) => person.linkedRecordIds.includes(record.id) && !record.archivedAt);
            const presentation = getDirectoryPersonPresentation(person);
            return (
              <article className="grid gap-3 bg-card px-4 py-4 transition hover:bg-muted/40 lg:grid-cols-[minmax(180px,1.2fr)_minmax(150px,0.9fr)_90px_minmax(170px,1fr)_120px] lg:items-center" key={person.id}>
                <div className="flex min-w-0 items-center gap-3"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${person.isStaff ? "bg-accent text-primary" : "bg-muted text-muted-foreground"}`}>{person.isStaff ? <ShieldCheck size={16} /> : <UserRound size={16} />}</span><span className="min-w-0"><strong className="block truncate text-sm text-foreground">{presentation.name}</strong><small className="mt-0.5 block truncate text-xs text-muted-foreground" title={presentation.detail}>{presentation.detail}</small>{person.isStaff ? <small className="mt-1 inline-block rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">Equipe</small> : null}</span></div>
                <span className="min-w-0 break-words text-sm text-muted-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Telefone</span>{presentation.phone}</span>
                <span className="text-sm font-semibold text-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Grupos</span>{person.activeGroupCount}</span>
                <div className="min-w-0"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Vínculos</span>{linkedRecords.length ? <div className="mt-1 flex flex-wrap gap-1.5 lg:mt-0">{linkedRecords.slice(0, 3).map((record) => <RecordChip key={record.id} record={record} recordTypes={recordTypes} />)}{linkedRecords.length > 3 ? <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">+{linkedRecords.length - 3}</span> : null}</div> : <span className="text-xs text-muted-foreground">Sem classificação</span>}</div>
                <span className="text-xs font-medium text-muted-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Atividade</span>{formatRelativeTime(person.lastActivityAt)}</span>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RecordsView({
  query,
  saving,
  snapshot,
  onArchive,
  onConfigure,
  onCreate,
  onEdit,
}: {
  query: string;
  saving: boolean;
  snapshot: DirectorySnapshot;
  onArchive: (id: string) => Promise<boolean>;
  onConfigure: () => void;
  onCreate: () => void;
  onEdit: (record: DirectoryRecord) => void;
}) {
  const [typeFilter, setTypeFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const activeTypes = snapshot.recordTypes.filter((type) => !type.archivedAt);
  const filtered = useMemo(() => snapshot.records.filter((record) => {
    const recordType = snapshot.recordTypes.find((type) => type.id === record.typeId);
    const fieldValues = Object.values(record.values).flatMap((value) => Array.isArray(value) ? value : [value]);
    return (showArchived || !record.archivedAt) && (typeFilter === "all" || record.typeId === typeFilter) && matchesQuery(query, record.name, record.description, recordType?.name, fieldValues);
  }), [query, showArchived, snapshot.recordTypes, snapshot.records, typeFilter]);

  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <ViewIntro icon={Building2} title={`${snapshot.records.filter((record) => !record.archivedAt).length} registros ativos`} description="Organizações e entidades opcionais, modeladas conforme a realidade desta instalação." />
        <div className="flex flex-col gap-2 sm:flex-row">
          <NativeSelect aria-label="Filtrar por tipo" className="min-w-44" onChange={(event) => setTypeFilter(event.target.value)} value={typeFilter}><option value="all">Todos os tipos</option>{activeTypes.map((type) => <option key={type.id} value={type.id}>{type.pluralName}</option>)}</NativeSelect>
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-muted-foreground"><Input checked={showArchived} className="h-4 w-4 accent-primary" onChange={(event) => setShowArchived(event.target.checked)} type="checkbox" /> Mostrar arquivados</label>
          <Button onClick={onConfigure} type="button" variant="outline"><FolderCog size={15} /> Tipos e campos</Button>
          <Button disabled={!activeTypes.length} onClick={onCreate} type="button"><Plus size={16} /> Novo registro</Button>
        </div>
      </div>

      {!activeTypes.length ? (
        <section className="mt-5 grid min-h-72 place-items-center rounded-2xl border border-dashed border-primary/20 bg-accent p-6 text-center">
          <div className="max-w-lg"><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-card text-primary shadow-sm"><Boxes size={21} /></span><h3 className="mt-4 text-base font-semibold text-foreground">Comece agnóstico e classifique quando fizer sentido</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Grupos e pessoas já funcionam sem registros. Se precisar, crie tipos como Parceiro, Unidade, Projeto, Departamento ou qualquer outro conceito da sua operação.</p><Button className="mt-5" onClick={onConfigure} type="button"><Plus size={16} /> Criar um tipo de registro</Button></div>
        </section>
      ) : filtered.length ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              saving={saving}
              snapshot={snapshot}
              onArchive={onArchive}
              onEdit={onEdit}
            />
          ))}
        </div>
      ) : <ViewEmpty query={query} kind="registro" />}
    </div>
  );
}

function RecordCard({
  record,
  saving,
  snapshot,
  onArchive,
  onEdit,
}: {
  record: DirectoryRecord;
  saving: boolean;
  snapshot: DirectorySnapshot;
  onArchive: (id: string) => Promise<boolean>;
  onEdit: (record: DirectoryRecord) => void;
}) {
  const recordType = snapshot.recordTypes.find((type) => type.id === record.typeId);
  const fields = snapshot.fields.filter((field) => field.recordTypeId === record.typeId && !field.archivedAt && record.values[field.id] !== null && record.values[field.id] !== undefined && record.values[field.id] !== "").sort((left, right) => left.position - right.position).slice(0, 4);
  const groups = snapshot.groups.filter((group) => record.groupIds.includes(group.id));
  const people = snapshot.people.filter((person) => record.personIds.includes(person.id));

  return (
    <article className={`min-w-0 rounded-2xl border bg-card p-4 shadow-sm ${record.archivedAt ? "border-border opacity-70" : "border-border"}`}>
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-base font-bold text-white" style={{ backgroundColor: recordType?.color ?? "#6558dd" }}>{record.name.slice(0, 1).toLocaleUpperCase("pt-BR")}</span>
        <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold text-foreground">{record.name}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{recordType?.name ?? "Registro"}{record.archivedAt ? " · Arquivado" : ""}</p></div>
        {!record.archivedAt ? <div className="flex shrink-0 gap-1"><Button aria-label={`Editar ${record.name}`} onClick={() => onEdit(record)} size="icon-sm" type="button" variant="outline"><Pencil size={14} /></Button><Button aria-label={`Arquivar ${record.name}`} className="hover:border-amber-200 hover:bg-amber-50 hover:text-amber-800" disabled={saving} onClick={() => { if (window.confirm(`Arquivar “${record.name}”? Conversas e tickets serão preservados.`)) void onArchive(record.id); }} size="icon-sm" type="button" variant="outline"><Archive size={14} /></Button></div> : null}
      </header>
      {record.description ? <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{record.description}</p> : null}
      <dl className="mt-4 grid grid-cols-3 divide-x divide-border/70 rounded-xl bg-muted py-3 text-center"><Stat value={record.ticketCount} label="tickets" /><Stat value={record.openTicketCount} label="abertos" tone={record.openTicketCount ? "amber" : "neutral"} /><Stat value={groups.length + people.length} label="vínculos" /></dl>
      {fields.length ? <dl className="mt-4 grid grid-cols-2 gap-3">{fields.map((field) => <div className="min-w-0" key={field.id}><dt className="truncate text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground">{field.label}</dt><dd className="mt-1 truncate text-xs font-medium text-foreground" title={displayFieldValue(field, record.values[field.id], snapshot)}>{displayFieldValue(field, record.values[field.id], snapshot)}</dd></div>)}</dl> : null}
      <div className="mt-4 flex flex-wrap gap-1.5">{groups.slice(0, 2).map((group) => { const presentation = getDirectoryGroupPresentation(group); return <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700" key={group.id} title={presentation.name}><UsersRound size={11} /><span className="truncate">{presentation.name}</span></span>; })}{people.slice(0, 2).map((person) => { const presentation = getDirectoryPersonPresentation(person); return <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground" key={person.id} title={presentation.name}><UserRound size={11} /><span className="truncate">{presentation.name}</span></span>; })}{groups.length + people.length > 4 ? <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">+{groups.length + people.length - 4}</span> : null}{!groups.length && !people.length ? <span className="text-xs text-muted-foreground">Sem grupos ou pessoas vinculados</span> : null}</div>
      <footer className="mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-xs text-muted-foreground"><span>Última atividade</span><strong className="font-semibold text-muted-foreground">{formatRelativeTime(record.lastActivityAt ?? record.updatedAt)}</strong></footer>
    </article>
  );
}

export function SegmentsView({
  query,
  snapshot,
  onCreate,
  onEdit,
}: {
  query: string;
  snapshot: DirectorySnapshot;
  onCreate: () => void;
  onEdit: (segment: DirectorySegment) => void;
}) {
  const filtered = useMemo(() => snapshot.segments.filter((segment) => {
    const recordType = snapshot.recordTypes.find((type) => type.id === segment.recordTypeId);
    return matchesQuery(query, segment.name, segment.description, recordType?.name);
  }), [query, snapshot.recordTypes, snapshot.segments]);

  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><ViewIntro icon={Filter} title={`${snapshot.segments.length} segmentos`} description="Filtros salvos para reencontrar conjuntos de registros sem duplicar dados." /><Button disabled={!snapshot.records.length} onClick={onCreate} type="button"><Plus size={16} /> Novo segmento</Button></div>
      {!snapshot.records.length ? (
        <section className="mt-5 grid min-h-64 place-items-center rounded-2xl border border-dashed border-border bg-muted p-6 text-center"><div className="max-w-md"><Filter className="mx-auto text-muted-foreground" size={24} /><h3 className="mt-3 font-semibold text-foreground">Segmentos ficam disponíveis com os registros</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Crie um tipo e pelo menos um registro antes de salvar filtros reutilizáveis.</p></div></section>
      ) : filtered.length ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((segment) => {
            const recordType = snapshot.recordTypes.find((type) => type.id === segment.recordTypeId);
            const members = snapshot.records.filter((record) => segment.memberRecordIds.includes(record.id));
            return (
              <Button className="min-w-0 rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition hover:border-primary/30 hover:shadow-md" key={segment.id} onClick={() => onEdit(segment)} size="unstyled" type="button" variant="unstyled">
                <header className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-primary"><Filter size={17} /></span><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold text-foreground">{segment.name}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{recordType?.pluralName ?? "Todos os tipos"}</p></div><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">{segment.memberCount}</span></header>
                {segment.description ? <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{segment.description}</p> : null}
                <div className="mt-4 rounded-xl border border-border/70 bg-muted p-3"><span className="text-xs font-bold uppercase tracking-[0.05em] text-muted-foreground">{segment.filters.length ? `${segment.match === "all" ? "Todos" : "Qualquer"} · ${segment.filters.length} critérios` : "Sem critérios"}</span><div className="mt-2 grid gap-1.5">{segment.filters.slice(0, 3).map((filter, index) => { const field = snapshot.fields.find((item) => item.id === filter.fieldId); return <span className="truncate text-xs text-muted-foreground" key={`${filter.fieldId}-${index}`}>{field?.label ?? "Campo removido"} {OPERATOR_LABELS[filter.operator]} {formatFilterValue(filter.value, snapshot)}</span>; })}{segment.filters.length > 3 ? <span className="text-xs font-semibold text-primary">+{segment.filters.length - 3} critérios</span> : null}</div></div>
                <div className="mt-4 flex items-center justify-between"><div className="flex min-w-0 -space-x-1">{members.slice(0, 3).map((record) => <span className="grid h-7 max-w-28 place-items-center truncate rounded-full border-2 border-white bg-accent px-2 text-xs font-semibold text-primary" key={record.id} title={record.name}>{record.name.slice(0, 12)}</span>)}{!members.length ? <span className="text-xs text-muted-foreground">Nenhum resultado atual</span> : null}</div><span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">Editar <ArrowRight size={13} /></span></div>
              </Button>
            );
          })}
        </div>
      ) : <ViewEmpty query={query} kind="segmento" />}
    </div>
  );
}

function ViewIntro({ icon: Icon, title, description }: { icon: typeof UsersRound; title: string; description: string }) {
  return <div className="flex min-w-0 items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Icon size={16} /></span><div className="min-w-0"><h2 className="text-sm font-semibold text-foreground">{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div></div>;
}

function ViewEmpty({ query, kind }: { query: string; kind: string }) {
  return <div className="p-4 sm:p-5"><EmptyState title={`Nenhum ${kind} encontrado`} description={query ? "Tente buscar por outro nome ou identificador." : `Os ${kind}s aparecerão aqui quando estiverem disponíveis.`} /></div>;
}

function Stat({ value, label, tone = "neutral" }: { value: number; label: string; tone?: "neutral" | "amber" }) {
  return <div><dt className={`text-base font-semibold ${tone === "amber" ? "text-amber-800" : "text-foreground"}`}>{value.toLocaleString("pt-BR")}</dt><dd className="mt-0.5 text-xs text-muted-foreground">{label}</dd></div>;
}

function LinkedRecords({ records, recordTypes }: { records: DirectoryRecord[]; recordTypes: DirectorySnapshot["recordTypes"] }) {
  return <div className="mt-4"><div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.05em] text-muted-foreground"><Link2 size={12} /> Registros vinculados</div>{records.length ? <div className="mt-2 flex flex-wrap gap-1.5">{records.slice(0, 4).map((record) => <RecordChip key={record.id} record={record} recordTypes={recordTypes} />)}{records.length > 4 ? <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">+{records.length - 4}</span> : null}</div> : <p className="mt-2 text-xs text-muted-foreground">Sem classificação adicional</p>}</div>;
}

function RecordChip({ record, recordTypes }: { record: DirectoryRecord; recordTypes: DirectorySnapshot["recordTypes"] }) {
  const type = recordTypes.find((item) => item.id === record.typeId);
  return <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-semibold text-foreground"><i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: type?.color ?? "#6558dd" }} /><span className="truncate">{record.name}</span></span>;
}

function displayFieldValue(field: DirectoryField, value: DirectoryValue, snapshot: DirectorySnapshot): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "boolean") return value ? "Sim" : "Não";
  if (field.type === "relation" && typeof value === "string") return snapshot.records.find((record) => record.id === value)?.name ?? "Registro indisponível";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function formatFilterValue(value: DirectorySegmentInput["filters"][number]["value"], snapshot: DirectorySnapshot): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return snapshot.records.find((record) => record.id === value)?.name ?? value;
  return String(value);
}
