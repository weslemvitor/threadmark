import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("configurações delegam IA e ferramentas ao Hermes sem apagar a API legada", async () => {
  const [settings, tools, app, navigation, client, api, sidebar, automations] = await Promise.all([
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/tools-settings-section.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/layout/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/automations/components/automations-view.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(settings, /id: "tools", label: "Ferramentas"/);
  assert.doesNotMatch(settings, /id: "ai", label: "IA"/);
  assert.doesNotMatch(settings, /<ToolsSettingsSection|<AiSection/);
  assert.match(tools, /A triagem nunca recebe estas ferramentas/);
  assert.match(tools, /Somente o Threadmark AI pode usar/);
  assert.match(tools, /Nova ferramenta/);
  assert.match(tools, /Editar/);
  assert.match(tools, /Testar/);
  assert.match(tools, /Desativar/);
  assert.match(tools, /Excluir a ferramenta/);
  assert.match(tools, /Credenciais são write-only/);
  assert.doesNotMatch(tools, /Ferramentas antigas encontradas/);
  assert.doesNotMatch(tools, /Revisar e importar selecionadas/);
  assert.doesNotMatch(tools, /getLegacyLocalToolCandidates/);
  assert.doesNotMatch(tools, /importLegacyLocalTools/);
  assert.match(app, /initialTab=\{settingsInitialTab\}/);
  assert.match(app, /onTabChange=\{openSettingsTab\}/);
  assert.doesNotMatch(app, /<ThreadmarkAi|queueTicketDocumentation|onGenerateDocumentation=/);
  assert.doesNotMatch(sidebar, /Documentações/);
  assert.doesNotMatch(automations, /ConnectedAppsPanel|Apps conectados|createConnectedApp/);
  assert.match(automations, /Fluxos internos/);
  assert.match(navigation, /"tools"/);
  assert.match(navigation, /if \(value === "team"\) return "staff"/);
  assert.match(navigation, /value === "ai" \|\| value === "tools"/);
  assert.match(client, /\/api\/tools/);
  assert.doesNotMatch(client, /\/api\/tools\/legacy-candidates/);
  assert.doesNotMatch(client, /\/api\/tools\/legacy-import/);
  assert.match(api, /requireRole\(context, \["owner", "admin"\]\)/);
  assert.doesNotMatch(tools, /sendMessage|Enviar ao WhatsApp/);
});
