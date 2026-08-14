import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function assertPrimaryButton(source: string, label: string) {
  const labelIndex = source.indexOf(label);
  assert.notEqual(labelIndex, -1, `Botão "${label}" não encontrado`);
  const buttonStart = source.lastIndexOf("<Button", labelIndex);
  assert.notEqual(buttonStart, -1, `Componente de "${label}" não encontrado`);
  assert.match(source.slice(buttonStart, labelIndex), /variant="default"/);
}

test("UI shadcn configura conectores agnósticos e cria pelo painel de registros", async () => {
  const [settings, dialog, contextPanel] = await Promise.all([
    readFile(
      new URL(
        "../app/features/settings/components/record-connectors-section.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/features/tickets/components/ticket-record-connector-dialog.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/features/tickets/components/ticket-context-panel.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  for (const component of [
    "AlertDialog",
    "Badge",
    "Button",
    "Checkbox",
    "Dialog",
    "Input",
    "Select",
    "Textarea",
  ]) {
    assert.match(settings, new RegExp(`<${component}\\b`));
  }
  assert.match(settings, /Conectores de registros/);
  assert.match(settings, /Linear, Intercom ou APIs próprias/);
  assertPrimaryButton(settings, "Novo conector");
  assertPrimaryButton(settings, "Salvar conector");
  assert.match(dialog, /Criar registro via conector/);
  assert.match(dialog, /getRecordConnectorCatalog/);
  assertPrimaryButton(dialog, "Criar e vincular");
  assert.match(contextPanel, /Registros vinculados/);
  assert.match(contextPanel, /Criar via conector/);
  assert.doesNotMatch(contextPanel, /Vincular Linear/);
});
