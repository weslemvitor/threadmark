"use client";

import {
  Building2,
  Filter,
  FolderCog,
  LoaderCircle,
  RefreshCw,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import type {
  DirectoryFieldDefinitionInput,
  DirectoryRecord,
  DirectoryRecordInput,
  DirectoryRecordTypeInput,
  DirectorySegment,
  DirectorySegmentInput,
  DirectorySnapshot,
} from "@/app/lib/types";
import { DirectoryRecordEditor } from "./directory-record-editor";
import { DirectorySchemaEditor } from "./directory-schema-editor";
import { DirectorySegmentEditor } from "./directory-segment-editor";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";

import { GroupsView, PeopleView, RecordsView, SegmentsView } from "./directory-panels";

type DirectoryTab = "groups" | "people" | "records" | "segments";

type DirectoryViewProps = {
  snapshot: DirectorySnapshot | null;
  loading: boolean;
  saving: boolean;
  onReload: () => Promise<void>;
  onCreateRecordType: (input: DirectoryRecordTypeInput) => Promise<boolean>;
  onUpdateRecordType: (id: string, input: DirectoryRecordTypeInput) => Promise<boolean>;
  onCreateField: (input: DirectoryFieldDefinitionInput) => Promise<boolean>;
  onUpdateField: (id: string, input: DirectoryFieldDefinitionInput) => Promise<boolean>;
  onCreateRecord: (input: DirectoryRecordInput) => Promise<boolean>;
  onUpdateRecord: (id: string, input: DirectoryRecordInput) => Promise<boolean>;
  onArchiveRecord: (id: string) => Promise<boolean>;
  onCreateSegment: (input: DirectorySegmentInput) => Promise<boolean>;
  onUpdateSegment: (id: string, input: DirectorySegmentInput) => Promise<boolean>;
  onDeleteSegment: (id: string) => Promise<boolean>;
};

const TABS: Array<{ id: DirectoryTab; label: string; icon: typeof UsersRound }> = [
  { id: "groups", label: "Grupos", icon: UsersRound },
  { id: "people", label: "Pessoas", icon: UserRound },
  { id: "records", label: "Registros", icon: Building2 },
  { id: "segments", label: "Segmentos", icon: Filter },
];





function tabCount(tab: DirectoryTab, snapshot: DirectorySnapshot): number {
  if (tab === "groups") return snapshot.totals.groups;
  if (tab === "people") return snapshot.totals.people;
  if (tab === "records") return snapshot.totals.records;
  return snapshot.totals.segments;
}

export function DirectoryView({
  snapshot,
  loading,
  saving,
  onReload,
  onCreateRecordType,
  onUpdateRecordType,
  onCreateField,
  onUpdateField,
  onCreateRecord,
  onUpdateRecord,
  onArchiveRecord,
  onCreateSegment,
  onUpdateSegment,
  onDeleteSegment,
}: DirectoryViewProps) {
  const [activeTab, setActiveTab] = useState<DirectoryTab>("groups");
  const [query, setQuery] = useState("");
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [recordEditor, setRecordEditor] = useState<DirectoryRecord | "new" | null>(null);
  const [segmentEditor, setSegmentEditor] = useState<DirectorySegment | "new" | null>(null);

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
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-primary"><FolderCog size={17} /></span>
              <div className="min-w-0">
                <strong className="block text-sm font-semibold text-foreground">Diretório da instalação</strong>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">Grupos e pessoas são nativos; qualquer classificação adicional é opcional.</span>
              </div>
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

        <div aria-label="Visões do diretório" className="flex min-w-0 gap-1 overflow-x-auto border-b border-border bg-muted px-2 py-2 sm:px-4" role="tablist">
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
                <span className={`grid min-w-5 place-items-center rounded-full px-1.5 py-0.5 text-xs ${active ? "bg-accent text-primary" : "bg-muted text-muted-foreground"}`}>{tabCount(tab.id, snapshot)}</span>
              </Button>
            );
          })}
        </div>

        <div role="tabpanel">
          {activeTab === "groups" ? <GroupsView groups={snapshot.groups} query={query} records={snapshot.records} recordTypes={snapshot.recordTypes} /> : null}
          {activeTab === "people" ? <PeopleView people={snapshot.people} query={query} records={snapshot.records} recordTypes={snapshot.recordTypes} /> : null}
          {activeTab === "records" ? (
            <RecordsView
              query={query}
              saving={saving}
              snapshot={snapshot}
              onArchive={onArchiveRecord}
              onConfigure={() => setSchemaOpen(true)}
              onCreate={() => setRecordEditor("new")}
              onEdit={setRecordEditor}
            />
          ) : null}
          {activeTab === "segments" ? <SegmentsView query={query} snapshot={snapshot} onCreate={() => setSegmentEditor("new")} onEdit={setSegmentEditor} /> : null}
        </div>
      </section>

      {schemaOpen ? (
        <DirectorySchemaEditor
          saving={saving}
          snapshot={snapshot}
          onCancel={() => setSchemaOpen(false)}
          onCreateField={onCreateField}
          onCreateRecordType={onCreateRecordType}
          onUpdateField={onUpdateField}
          onUpdateRecordType={onUpdateRecordType}
        />
      ) : null}
      {recordEditor ? (
        <DirectoryRecordEditor
          record={recordEditor === "new" ? null : recordEditor}
          saving={saving}
          snapshot={snapshot}
          onCancel={() => setRecordEditor(null)}
          onSave={(input) => recordEditor === "new" ? onCreateRecord(input) : onUpdateRecord(recordEditor.id, input)}
        />
      ) : null}
      {segmentEditor ? (
        <DirectorySegmentEditor
          saving={saving}
          segment={segmentEditor === "new" ? null : segmentEditor}
          snapshot={snapshot}
          onCancel={() => setSegmentEditor(null)}
          onDelete={onDeleteSegment}
          onSave={(input) => segmentEditor === "new" ? onCreateSegment(input) : onUpdateSegment(segmentEditor.id, input)}
        />
      ) : null}
    </div>
  );
}
