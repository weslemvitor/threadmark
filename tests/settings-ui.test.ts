import assert from "node:assert/strict";
import test from "node:test";
import { readFrontendFile as readFile } from "./helpers/frontend-source.js";

import {
  connectionSupportsTask,
} from "../app/lib/ai-task-capabilities.js";

test("configurações fazem parte da navegação e preservam fronteira local-first", async () => {
  const [sidebar, app, settings, api, navigation] = await Promise.all([
    readFile(new URL("../app/components/layout/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/navigation.ts", import.meta.url), "utf8"),
  ]);

  assert.match(sidebar, /id: "settings"/);
  assert.match(app, /case "settings"/);
  assert.match(settings, /Integração estritamente somente leitura/);
  assert.match(settings, /overflow-x-auto overflow-y-hidden/);
  assert.match(settings, /\[scrollbar-width:none\] \[&::\-webkit-scrollbar\]:hidden/);
  assert.match(settings, /renewWhatsappQr/);
  assert.match(settings, /Gerar QR code/);
  assert.match(settings, /Gerando QR code/);
  assert.doesNotMatch(settings, /id:\s*"ai"|id:\s*"tools"|<AiSection|<ToolsSettingsSection/);
  assert.match(settings, /requestedTab === "ai" \|\| requestedTab === "tools"/);
  assert.match(navigation, /value === "ai" \|\| value === "tools"/);
  assert.match(settings, /lastBackup\.directory/);
  assert.match(settings, /Armazenamento local/);
  assert.match(settings, /Total de dados locais/);
  assert.match(settings, /SQLite \+ WAL\/SHM/);
  assert.match(settings, /Outros dados locais/);
  assert.match(settings, /Atualizar uso/);
  assert.match(api, /\/api\/settings\/backup/);
  assert.match(api, /\/api\/settings\/storage/);
  assert.doesNotMatch(settings, /Codex CLI fica reservado/);
  assert.doesNotMatch(settings, /Enviar ao WhatsApp|sendMessage/);
});

test("conexões são oferecidas conforme a capacidade específica de cada tarefa", () => {
  const capabilities = {
    structuredOutput: true,
    vision: true,
    triage: true,
    automaticAnalysis: true,
    localTools: false,
    codebaseAccess: false,
    deepInvestigation: false,
  };
  const connection = {
    id: "connection-1",
    label: "Conexão de teste",
    providerId: "openai",
    baseUrl: null,
    enabled: true,
    hasSecret: true,
    secretLastFour: "test",
    capabilities,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
  };

  assert.equal(connectionSupportsTask(connection, "triage"), true);
  assert.equal(connectionSupportsTask(connection, "automatic"), true);
  assert.equal(connectionSupportsTask(connection, "deep"), false);
  assert.equal(connectionSupportsTask(connection, "quick"), false);
  assert.equal(
    connectionSupportsTask({
      ...connection,
      capabilities: { ...capabilities, deepInvestigation: true },
    }, "deep"),
    true,
  );
  assert.equal(
    connectionSupportsTask({ ...connection, enabled: false }, "triage"),
    false,
  );

  const codex = {
    ...connection,
    id: "builtin-codex",
    label: "Codex CLI",
    providerId: "codex",
    hasSecret: false,
    secretLastFour: null,
    capabilities: {
      ...capabilities,
      localTools: true,
      codebaseAccess: true,
      deepInvestigation: true,
    },
  };
  assert.equal(connectionSupportsTask(codex, "triage"), true);
  assert.equal(connectionSupportsTask(codex, "automatic"), true);
  assert.equal(connectionSupportsTask(codex, "deep"), true);
  assert.equal(connectionSupportsTask(codex, "quick"), true);
});

test("clientes de API encerram a sessão visual ao receber 401", async () => {
  const [api, access, settings, gate, events] = await Promise.all([
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/access.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/access/components/app-access-gate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/session-events.ts", import.meta.url), "utf8"),
  ]);

  assert.match(api, /response\.status === 401.*notifySessionExpired/);
  assert.match(access, /response\.status === 401.*notifySessionExpired/);
  assert.match(settings, /response\.status === 401.*notifySessionExpired/);
  assert.match(gate, /subscribeSessionExpired\(\(\) => setSession\(null\)\)/);
  assert.match(events, /threadmark:session-expired/);
});

test("estados de acesso permanecem centralizados no workspace", async () => {
  const gate = await readFile(
    new URL("../app/features/access/components/app-access-gate.tsx", import.meta.url),
    "utf8",
  );

  assert.match(gate, /relative z-10 grid w-full place-items-center/);
  assert.match(gate, /Não foi possível abrir o workspace/);
});

test("configuração de áudio usa componentes Shadcn e expõe recursos locais", async () => {
  const [aiSection, audioSection, progress, switchComponent] = await Promise.all([
    readFile(new URL("../app/features/settings/components/sections/ai-section.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/audio-transcription-section.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/progress.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/switch.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(aiSection, /<AudioTranscriptionSection/);
  assert.match(audioSection, /from "@\/app\/components\/ui\/select"/);
  assert.match(audioSection, /from "@\/app\/components\/ui\/switch"/);
  assert.match(audioSection, /from "@\/app\/components\/ui\/progress"/);
  assert.match(audioSection, /Transcrever novos áudios automaticamente/);
  assert.match(audioSection, /Transcrever áudios antigos/);
  assert.match(audioSection, /Modelo instalado, transcrição desativada/);
  assert.match(audioSection, /Ativar agora/);
  assert.match(audioSection, /async function activate/);
  assert.match(audioSection, /enabled: true/);
  assert.match(audioSection, /autoTranscribeNew: true/);
  assert.match(audioSection, /RAM estimada/);
  assert.match(audioSection, /Disco do modelo/);
  assert.match(audioSection, /xl:grid-cols-3/);
  assert.match(progress, /Progress as ProgressPrimitive.*from "radix-ui"/);
  assert.match(switchComponent, /data-\[state=checked\]:bg-primary/);
  assert.match(switchComponent, /data-\[state=unchecked\]:bg-input/);
  assert.match(switchComponent, /data-\[state=checked\]:translate-x/);
  assert.doesNotMatch(switchComponent, /data-checked:|data-unchecked:/);
  assert.doesNotMatch(audioSection, /#[0-9a-fA-F]{3,8}/);
});
