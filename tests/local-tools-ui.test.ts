import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("configurações expõem uma tela dedicada de ferramentas com fronteira profunda", async () => {
  const [settings, tools, app, navigation, client, api] = await Promise.all([
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/tools-settings-section.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(settings, /id: "tools", label: "Ferramentas"/);
  assert.match(settings, /<ToolsSettingsSection/);
  assert.match(tools, /A triagem nunca recebe estas ferramentas/);
  assert.match(tools, /Somente a sala de investigação pode usar/);
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
  assert.match(navigation, /"tools"/);
  assert.match(navigation, /if \(value === "team"\) return "staff"/);
  assert.match(client, /\/api\/tools/);
  assert.doesNotMatch(client, /\/api\/tools\/legacy-candidates/);
  assert.doesNotMatch(client, /\/api\/tools\/legacy-import/);
  assert.match(api, /requireRole\(context, \["owner", "admin"\]\)/);
  assert.doesNotMatch(tools, /sendMessage|Enviar ao WhatsApp/);
});
