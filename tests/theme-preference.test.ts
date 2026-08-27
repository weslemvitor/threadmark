import assert from "node:assert/strict";
import test from "node:test";

import {
  isThemePreference,
  resolveThemePreference,
} from "../app/lib/theme.js";

test("valida apenas preferências de tema suportadas", () => {
  assert.equal(isThemePreference("light"), true);
  assert.equal(isThemePreference("dark"), true);
  assert.equal(isThemePreference("system"), true);
  assert.equal(isThemePreference("automatic"), false);
  assert.equal(isThemePreference(null), false);
});

test("resolve o tema do sistema sem alterar escolhas explícitas", () => {
  assert.equal(resolveThemePreference("system", true), "dark");
  assert.equal(resolveThemePreference("system", false), "light");
  assert.equal(resolveThemePreference("light", true), "light");
  assert.equal(resolveThemePreference("dark", false), "dark");
});
