import assert from "node:assert/strict";
import test from "node:test";
import { readFrontendFile as readFile } from "./helpers/frontend-source.js";

import {
  getDirectoryGroupPresentation,
  getDirectoryPersonPresentation,
  getRequesterPresentation,
} from "../app/lib/format.js";

const source = (relativePath: string) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

test("Diretório mantém somente as visões nativas de grupos e pessoas", async () => {
  const [sidebar, supportApp, directoryView, panels] = await Promise.all([
    source("../app/components/layout/sidebar.tsx"),
    source("../app/support-app.tsx"),
    source("../app/features/directory/components/directory-view.tsx"),
    source("../app/features/directory/components/directory-panels.tsx"),
  ]);

  assert.match(sidebar, /label: "Diretório"/);
  assert.match(supportApp, /subtitle: "Grupos e pessoas sincronizados do WhatsApp"/);
  assert.match(directoryView, /label: "Grupos"/);
  assert.match(directoryView, /label: "Pessoas"/);
  assert.doesNotMatch(directoryView, /Registros|Segmentos/);
  assert.doesNotMatch(supportApp, /DirectoryRecord|DirectorySegment|RecordConnector/);
  assert.match(panels, /export function GroupsView/);
  assert.match(panels, /export function PeopleView/);
  assert.doesNotMatch(panels, /linkedRecordIds|registro personalizado|segmento/i);
});

test("tickets e dashboard não apresentam dimensões de registros removidas", async () => {
  const [detail, contextPanel, dashboard, contracts] = await Promise.all([
    source("../app/features/tickets/components/ticket-detail.tsx"),
    source("../app/features/tickets/components/ticket-context-panel.tsx"),
    source("../app/features/dashboard/components/dashboard-view.tsx"),
    source("../shared/contracts.ts"),
  ]);

  assert.doesNotMatch(detail, /directoryContext|TicketContextEditor|RecordConnector/);
  assert.doesNotMatch(contextPanel, /Registros vinculados|Campos personalizados/);
  assert.match(contextPanel, /Solicitante/);
  assert.match(contextPanel, /Grupo/);
  assert.match(dashboard, /Tickets por grupo/);
  assert.doesNotMatch(dashboard, /recordBreakdowns|fieldBreakdowns|topRecords/);
  assert.doesNotMatch(contracts, /DirectoryRecord|DirectorySegment|RecordConnector/);
});

test("Diretório mantém estados vazios e layout responsivo", async () => {
  const [directoryView, panels] = await Promise.all([
    source("../app/features/directory/components/directory-view.tsx"),
    source("../app/features/directory/components/directory-panels.tsx"),
  ]);

  assert.match(directoryView, /Carregando diretório local/);
  assert.match(directoryView, /Diretório indisponível/);
  assert.match(directoryView, /sm:/);
  assert.match(directoryView, /lg:/);
  assert.match(directoryView, /aria-label=/);
  assert.match(panels, /Nenhum \$\{kind\} disponível/);
  assert.match(panels, /min-w-0/);
  assert.match(panels, /break-words/);
});

test("Diretório apresenta identidades do WhatsApp sem destacar JIDs técnicos", async () => {
  const panels = await source("../app/features/directory/components/directory-panels.tsx");

  assert.match(panels, /getDirectoryGroupPresentation/);
  assert.match(panels, /getDirectoryPersonPresentation/);
  assert.doesNotMatch(panels, />\{group\.externalJid\}</);
  assert.doesNotMatch(panels, />\{person\.externalJid\}</);

  assert.deepEqual(
    getDirectoryGroupPresentation({
      subject: "120363000000000101@g.us",
      externalJid: "120363000000000101@g.us",
    }),
    { name: "Grupo sem nome", detail: "Grupo do WhatsApp" },
  );
  assert.deepEqual(
    getDirectoryPersonPresentation({
      displayName: "Pessoa Fictícia Gama",
      phoneE164: "+551100000000",
      externalJid: "551100000000@s.whatsapp.net",
    }),
    {
      name: "Pessoa Fictícia Gama",
      detail: "+55 (11) 0000-0000",
      phone: "+55 (11) 0000-0000",
    },
  );
  assert.deepEqual(
    getDirectoryPersonPresentation({
      displayName: "900000000000101@lid",
      phoneE164: null,
      externalJid: "900000000000101@lid",
    }),
    {
      name: "Identidade protegida do WhatsApp",
      detail: "Identidade protegida do WhatsApp",
      phone: "Identidade protegida do WhatsApp",
    },
  );
  assert.deepEqual(
    getRequesterPresentation({
      displayName: "99900000000@s.whatsapp.net",
      phoneE164: null,
    }),
    {
      name: "+99900000000",
      phone: "+99900000000",
      compact: "+99900000000",
    },
  );
});
