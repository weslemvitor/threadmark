"use client";

import {
  CheckCircle2,
  CircleSlash,
  MessageSquareText,
  ShieldCheck,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { EmptyState } from "@/app/components/shared/ui-states";
import { formatRelativeTime, getDirectoryGroupPresentation, getDirectoryPersonPresentation } from "@/app/lib/format";
import type { DirectorySnapshot } from "@/app/lib/types";

type DirectoryGroup = DirectorySnapshot["groups"][number];
type DirectoryPerson = DirectorySnapshot["people"][number];

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
}: {
  groups: DirectoryGroup[];
  query: string;
}) {
  const filtered = useMemo(
    () => groups.filter((group) => matchesQuery(query, group.subject, group.externalJid)),
    [groups, query],
  );

  if (!filtered.length) return <ViewEmpty query={query} kind="grupo" />;

  return (
    <div className="p-4 sm:p-5">
      <ViewIntro icon={MessageSquareText} title={`${filtered.length} grupos`} description="Conversas coletivas sincronizadas do WhatsApp." />
      <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {filtered.map((group) => {
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
}: {
  people: DirectoryPerson[];
  query: string;
}) {
  const filtered = useMemo(
    () => people.filter((person) => matchesQuery(query, person.displayName, person.phoneE164, person.externalJid)),
    [people, query],
  );

  if (!filtered.length) return <ViewEmpty query={query} kind="pessoa" />;

  return (
    <div className="p-4 sm:p-5">
      <ViewIntro icon={UserRound} title={`${filtered.length} pessoas`} description="Participantes observados nos grupos e conversas sincronizadas." />
      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-[minmax(180px,1.2fr)_minmax(150px,0.9fr)_90px_120px] gap-3 border-b border-border bg-muted px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground lg:grid"><span>Pessoa</span><span>Telefone</span><span>Grupos</span><span>Atividade</span></div>
        <div className="divide-y divide-border/70">
          {filtered.map((person) => {
            const presentation = getDirectoryPersonPresentation(person);
            return (
              <article className="grid gap-3 bg-card px-4 py-4 transition hover:bg-muted/40 lg:grid-cols-[minmax(180px,1.2fr)_minmax(150px,0.9fr)_90px_120px] lg:items-center" key={person.id}>
                <div className="flex min-w-0 items-center gap-3"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${person.isStaff ? "bg-accent text-primary" : "bg-muted text-muted-foreground"}`}>{person.isStaff ? <ShieldCheck size={16} /> : <UserRound size={16} />}</span><span className="min-w-0"><strong className="block truncate text-sm text-foreground">{presentation.name}</strong><small className="mt-0.5 block truncate text-xs text-muted-foreground" title={presentation.detail}>{presentation.detail}</small>{person.isStaff ? <small className="mt-1 inline-block rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">Equipe</small> : null}</span></div>
                <span className="min-w-0 break-words text-sm text-muted-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Telefone</span>{presentation.phone}</span>
                <span className="text-sm font-semibold text-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Grupos</span>{person.activeGroupCount}</span>
                <span className="text-xs font-medium text-muted-foreground"><span className="mr-2 text-xs font-bold uppercase text-muted-foreground lg:hidden">Atividade</span>{formatRelativeTime(person.lastActivityAt)}</span>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ViewIntro({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-primary"><Icon size={17} /></span><div className="min-w-0"><h2 className="text-sm font-semibold text-foreground">{title}</h2><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p></div></div>;
}

function Stat({ value, label, tone = "neutral" }: { value: number; label: string; tone?: "neutral" | "amber" }) {
  return <div><dd className={`text-base font-bold ${tone === "amber" ? "text-amber-700" : "text-foreground"}`}>{value}</dd><dt className="mt-0.5 text-xs text-muted-foreground">{label}</dt></div>;
}

function ViewEmpty({ query, kind }: { query: string; kind: string }) {
  return <div className="p-5"><EmptyState title={query ? `Nenhum ${kind} encontrado` : `Nenhum ${kind} disponível`} description={query ? "Tente buscar por outro nome, telefone ou identificador." : "Os dados aparecerão após a sincronização do WhatsApp."} /></div>;
}
