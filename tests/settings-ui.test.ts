import assert from "node:assert/strict";
import test from "node:test";
import { readFrontendFile as readFile } from "./helpers/frontend-source.js";

test("configurações fazem parte da navegação e preservam fronteira local-first", async () => {
  const [sidebar, app, settings, general, api, navigation] = await Promise.all([
    readFile(new URL("../app/components/layout/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/sections/general-section.tsx", import.meta.url), "utf8"),
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
  assert.match(general, /Seu horário de trabalho/);
  assert.match(general, /Todos os dias/);
  assert.match(general, /Horário de trabalho desativado/);
  assert.match(general, /type="time"/);
  assert.match(general, /Adicionar período/);
  assert.match(general, /workSchedule/);
  assert.match(api, /\/api\/settings\/backup/);
  assert.match(api, /\/api\/settings\/storage/);
  assert.doesNotMatch(settings, /Codex CLI fica reservado/);
  assert.doesNotMatch(settings, /Enviar ao WhatsApp|sendMessage/);
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
