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

test("navegação e página principal apresentam o Diretório em linguagem agnóstica", async () => {
  const [sidebar, supportApp, directoryView] = await Promise.all([
    source("../app/components/layout/sidebar.tsx"),
    source("../app/support-app.tsx"),
    source("../app/features/directory/components/directory-view.tsx"),
  ]);

  assert.match(sidebar, /label: "Diretório"/);
  assert.doesNotMatch(sidebar, /label: "Clientes"/);
  assert.match(
    supportApp,
    /import\("\.\/features\/directory"\)\.then\(\(module\) => module\.DirectoryView\)/,
  );
  assert.match(supportApp, /title: "Diretório"/);
  assert.match(
    supportApp,
    /subtitle: "Grupos e pessoas nativos, com registros personalizados opcionais"/,
  );
  assert.doesNotMatch(supportApp, /import \{ ClientsView \}/);

  for (const tab of ["Grupos", "Pessoas", "Registros", "Segmentos"]) {
    assert.match(
      directoryView,
      new RegExp(`label: "${tab}"`),
      `a aba ${tab} deve estar disponível`,
    );
  }
  assert.match(directoryView, /Diretório da instalação/);
  assert.match(directoryView, /Grupos e pessoas são nativos/);
  assert.match(directoryView, /Sem classificação adicional/);
  assert.match(directoryView, /Parceiro, Unidade, Projeto, Departamento/);
  assert.doesNotMatch(directoryView, /Agências, ecommerces/);
  assert.doesNotMatch(directoryView, /clientes mapeados/i);
  assert.doesNotMatch(directoryView, /Cliente[s]? com mais tickets/i);
});

test("Diretório oferece tipos, campos, relações e segmentos sem impor modelo comercial", async () => {
  const [directoryView, schemaEditor, recordEditor, segmentEditor] =
    await Promise.all([
      source("../app/features/directory/components/directory-view.tsx"),
      source("../app/features/directory/components/directory-schema-editor.tsx"),
      source("../app/features/directory/components/directory-record-editor.tsx"),
      source("../app/features/directory/components/directory-segment-editor.tsx"),
    ]);
  const directorySurface = [
    directoryView,
    schemaEditor,
    recordEditor,
    segmentEditor,
  ].join("\n");

  assert.match(schemaEditor, /Tipos e campos personalizados/);
  assert.match(schemaEditor, /Crie sua própria estrutura/);
  assert.match(schemaEditor, /Texto/);
  assert.match(schemaEditor, /Número/);
  assert.match(schemaEditor, /Sim ou não/);
  assert.match(schemaEditor, /Data/);
  assert.match(schemaEditor, /URL/);
  assert.match(schemaEditor, /Seleção única/);
  assert.match(schemaEditor, /Seleção múltipla/);
  assert.match(schemaEditor, /Relação com registro/);
  assert.match(recordEditor, /Campos personalizados/);
  assert.match(recordEditor, /Vínculos opcionais/);
  assert.match(recordEditor, /label="Grupos"/);
  assert.match(recordEditor, /label="Pessoas"/);
  assert.match(recordEditor, /label="Outros registros"/);
  assert.match(segmentEditor, /filtros salvos sobre registros/i);
  assert.match(segmentEditor, /todos forem verdadeiros/);
  assert.match(segmentEditor, /qualquer um for verdadeiro/);

  assert.doesNotMatch(directorySurface, /sendMessage/);
  assert.doesNotMatch(directorySurface, /Enviar mensagem/i);
  assert.doesNotMatch(directorySurface, /responder pelo WhatsApp/i);
  assert.doesNotMatch(directorySurface, /composer/i);
});

test("tickets usam registros e campos personalizados em vez de cliente ou ecommerce fixo", async () => {
  const [detail, editor] = await Promise.all([
    source("../app/features/tickets/components/ticket-detail.tsx"),
    source("../app/features/tickets/components/ticket-context-editor.tsx"),
  ]);

  assert.match(detail, /Registros vinculados/);
  assert.match(detail, /Campos personalizados do Diretório/);
  assert.match(detail, /ticket\.directoryContext\.records\.map/);
  assert.match(editor, /Vincular registros do Diretório/);
  assert.match(editor, /snapshot\?\.records/);
  assert.match(editor, /recordIds: selectedRecordIds/);
  assert.match(editor, /sm:max-w-2xl/);
  assert.match(editor, /min-h-0 min-w-0 flex-1/);
  assert.match(editor, /md:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(editor, /grid w-full min-w-0 grid-cols-2 gap-2 md:w-auto/);
  assert.match(editor, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(detail, /Ecommerce afetado|Cliente não identificado/);
  assert.doesNotMatch(editor, /Associar cliente e ecommerce|rememberForConversation/);
});

test("dashboard usa grupos por padrão e libera dimensões personalizadas somente quando existem", async () => {
  const [dashboard, contracts] = await Promise.all([
    source("../app/features/dashboard/components/dashboard-view.tsx"),
    source("../shared/contracts.ts"),
  ]);

  assert.match(dashboard, /Grupos por padrão; registros são opcionais/);
  assert.match(dashboard, /<option value="group">Grupo<\/option>/);
  assert.match(dashboard, /currentDashboard\.recordBreakdowns\.map/);
  assert.match(dashboard, /currentDashboard\.fieldBreakdowns\.map/);
  assert.match(dashboard, /fieldLabel/);
  assert.doesNotMatch(dashboard, /Clientes com mais tickets/);

  assert.match(contracts, /topGroups:/);
  assert.match(contracts, /recordBreakdowns:/);
  assert.match(contracts, /fieldBreakdowns:/);
  assert.match(contracts, /@deprecated Use topGroups or recordBreakdowns/);
});

test("Diretório mantém estados vazios e layout responsivo para instalação nova", async () => {
  const directoryView = await source("../app/features/directory/components/directory-view.tsx");

  assert.match(directoryView, /Comece agnóstico e classifique quando fizer sentido/);
  assert.match(directoryView, /Grupos e pessoas já funcionam sem registros/);
  assert.match(directoryView, /Segmentos ficam disponíveis com os registros/);
  assert.match(directoryView, /overflow-x-auto/);
  assert.match(directoryView, /sm:/);
  assert.match(directoryView, /lg:/);
  assert.match(directoryView, /aria-label=/);
});

test("Diretório apresenta identidades do WhatsApp sem destacar JIDs técnicos", async () => {
  const directoryView = await source("../app/features/directory/components/directory-view.tsx");

  assert.match(directoryView, /getDirectoryGroupPresentation/);
  assert.match(directoryView, /getDirectoryPersonPresentation/);
  assert.doesNotMatch(directoryView, />\{group\.externalJid\}</);
  assert.doesNotMatch(directoryView, />\{person\.externalJid\}</);
  assert.doesNotMatch(directoryView, /title=\{group\.externalJid\}/);
  assert.doesNotMatch(directoryView, /title=\{person\.externalJid\}/);

  assert.deepEqual(
    getDirectoryGroupPresentation({
      subject: "120363000000000101@g.us",
      externalJid: "120363000000000101@g.us",
    }),
    {
      name: "Grupo sem nome",
      detail: "Grupo do WhatsApp",
    },
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
      displayName: "+551100000000",
      phoneE164: null,
      externalJid: "900000000000101@lid",
    }),
    {
      name: "+55 (11) 0000-0000",
      detail: "Contato do WhatsApp",
      phone: "+55 (11) 0000-0000",
    },
  );
  assert.deepEqual(
    getDirectoryPersonPresentation({
      displayName: "99900000000@s.whatsapp.net",
      phoneE164: null,
      externalJid: "99900000000@s.whatsapp.net",
    }),
    {
      name: "+99900000000",
      detail: "Contato do WhatsApp",
      phone: "+99900000000",
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
    getDirectoryPersonPresentation({
      displayName: "Participante 900000000000101",
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
  assert.deepEqual(
    getRequesterPresentation({
      displayName: "900000000000101@lid",
      phoneE164: null,
    }),
    {
      name: "Identidade protegida do WhatsApp",
      phone: null,
      compact: "Identidade protegida do WhatsApp",
    },
  );
  assert.deepEqual(
    getRequesterPresentation({
      displayName: "Participante 900000000000101",
      phoneE164: null,
    }),
    {
      name: "Identidade protegida do WhatsApp",
      phone: null,
      compact: "Identidade protegida do WhatsApp",
    },
  );
});
