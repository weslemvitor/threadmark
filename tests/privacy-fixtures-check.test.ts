import assert from "node:assert/strict";
import test from "node:test";

import {
  findUnsafeIdentifiers,
  isClearlySyntheticIdentifier,
} from "../bin/privacy-fixtures-check.mjs";

test("aceita apenas identificadores claramente sintéticos", () => {
  assert.equal(isClearlySyntheticIdentifier("5500000000976"), true);
  assert.equal(isClearlySyntheticIdentifier("900000000000197", "lid"), true);
  assert.equal(isClearlySyntheticIdentifier("120363000000000197", "group"), true);
});

test("reprova telefone e LID com aparência real sem registrar PII no teste", () => {
  const phone = ["5547", "8862", "9768"].join("");
  const lid = ["21183", "21323", "86896"].join("");
  const findings = findUnsafeIdentifiers(
    `phoneE164: "+${phone}"; externalJid: "${lid}@lid";`,
    "fixture.ts",
  );

  assert.deepEqual(
    findings.map(({ kind }) => kind).sort(),
    ["phone", "whatsapp-lid"],
  );
});
