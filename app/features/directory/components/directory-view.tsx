"use client";

import {
  FolderCog,
  LoaderCircle,
  RefreshCw,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";
import type { DirectorySnapshot } from "@/app/lib/types";
import { GroupsView, PeopleView } from "./directory-panels";

type DirectoryTab = "groups" | "people";

type DirectoryViewProps = {
  snapshot: DirectorySnapshot | null;
  loading: boolean;
  onReload: () => Promise<void>;
};

const TABS: Array<{ id: DirectoryTab; label: string; icon: typeof UsersRound }> = [
  { id: "groups", label: "Grupos", icon: UsersRound },
  { id: "people", label: "Pessoas", icon: UserRound },
];

export function DirectoryView({
  snapshot,
  loading,
  onReload,
}: DirectoryViewProps) {
  const [activeTab, setActiveTab] = useState<DirectoryTab>("groups");
  const [query, setQuery] = useState("");

  if (loading && !snapshot) return <LoadingState label="Carregando diretório local…" />;
  if (!snapshot) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState title="Diretório indisponível" description="Atualize a tela para carregar grupos e pessoas armazenados localmente." />
        <div className="mt-4 flex justify-center"><Button onClick={() => void onReload()} type="button" variant="outline"><RefreshCw size={15} /> Tentar novamente</Button></div>
      </div>
    );
  }

  return (
    <div className="min-w-0 px-3 py-4 text-foreground sm:px-5 sm:py-5 lg:px-6">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-4 border-b border-border p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-primary"><FolderCog size={17} /></span>
            <div className="min-w-0">
              <strong className="block text-sm font-semibold text-foreground">Diretório da instalação</strong>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">Grupos e pessoas sincronizados do WhatsApp.</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <label className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-border bg-muted px-3 text-muted-foreground sm:w-72">
              <Search size={16} />
              <span className="sr-only">Buscar no diretório</span>
              <Input className="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nesta visão" type="search" value={query} />
            </label>
            <Button aria-label="Atualizar diretório" className="size-10 self-end sm:self-auto" disabled={loading} onClick={() => void onReload()} size="icon" type="button" variant="outline">
              {loading ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
            </Button>
          </div>
        </div>

        <div aria-label="Visões do diretório" className="flex min-w-0 gap-1 border-b border-border bg-muted px-2 py-2 sm:px-4" role="tablist">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <Button
                aria-selected={active}
                className={active ? "bg-card text-primary shadow-sm ring-1 ring-primary/20 hover:bg-card" : ""}
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setQuery(""); }}
                role="tab"
                size="lg"
                type="button"
                variant="ghost"
              >
                <Icon size={15} /> {tab.label}
                <span className={`grid min-w-5 place-items-center rounded-full px-1.5 py-0.5 text-xs ${active ? "bg-accent text-primary" : "bg-muted text-muted-foreground"}`}>{snapshot.totals[tab.id]}</span>
              </Button>
            );
          })}
        </div>

        <div role="tabpanel">
          {activeTab === "groups" ? <GroupsView groups={snapshot.groups} query={query} /> : null}
          {activeTab === "people" ? <PeopleView people={snapshot.people} query={query} /> : null}
        </div>
      </section>
    </div>
  );
}
