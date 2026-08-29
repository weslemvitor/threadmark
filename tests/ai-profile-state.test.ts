import assert from "node:assert/strict";
import test from "node:test";

import { aiTaskProfilesMatch } from "../app/lib/ai-profile-state.js";
import type {
  ComparableAiTaskKind,
  ComparableAiTaskProfile,
} from "../app/lib/ai-profile-state.js";

function profile(
  taskKind: ComparableAiTaskKind,
  model: string,
  overrides: Partial<ComparableAiTaskProfile & { updatedAt: string }> = {},
): ComparableAiTaskProfile & { updatedAt: string } {
  return {
    taskKind,
    connectionId: "builtin-codex",
    model,
    enabled: true,
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

test("dirty state de IA ignora metadados, ordem e espaços externos", () => {
  const persisted = [
    profile("triage", "default"),
    profile("automatic", "gpt-5.6-luna"),
    profile("quick", "gpt-5.6-terra"),
    profile("deep", "default"),
  ];
  const drafts = [
    profile("deep", "  default  ", { updatedAt: "" }),
    profile("quick", " gpt-5.6-terra ", { updatedAt: "" }),
    profile("triage", " default ", { updatedAt: "" }),
    profile("automatic", "gpt-5.6-luna", { updatedAt: "tomorrow" }),
  ];

  assert.equal(aiTaskProfilesMatch(drafts, persisted), true);
});

test("dirty state ignora perfil legado que não é administrado pela tela", () => {
  const persisted = [
    profile("triage", "default"),
    profile("automatic", "modelo-legado"),
    profile("quick", "gpt-5.6-terra"),
    profile("deep", "default"),
  ];
  const visibleDrafts = [
    profile("triage", "default"),
    profile("quick", "gpt-5.6-terra"),
    profile("deep", "default"),
  ];

  assert.equal(aiTaskProfilesMatch(visibleDrafts, persisted), true);
});

test("dirty state de IA detecta mudanças de conexão, modelo e ativação", () => {
  const persisted = [
    profile("triage", "default"),
    profile("automatic", "gpt-5.6-luna"),
    profile("quick", "gpt-5.6-terra"),
    profile("deep", "default"),
  ];

  assert.equal(
    aiTaskProfilesMatch(
      persisted.map((item) =>
        item.taskKind === "triage" ? { ...item, enabled: false } : item,
      ),
      persisted,
    ),
    false,
  );
  assert.equal(
    aiTaskProfilesMatch(
      persisted.map((item) =>
        item.taskKind === "automatic" ? { ...item, model: "outro" } : item,
      ),
      persisted,
    ),
    false,
  );
  assert.equal(
    aiTaskProfilesMatch(
      persisted.map((item) =>
        item.taskKind === "deep" ? { ...item, connectionId: null } : item,
      ),
      persisted,
    ),
    false,
  );
});
