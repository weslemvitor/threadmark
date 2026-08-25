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
  const phone = ["5510", "8764", "3210"].join("");
  const lid = ["70024", "68135", "79024"].join("");
  const email = ["pessoa", "private.invalid"].join("@");
  const localPath = ["", "Users", "pessoa-local", "Downloads"].join("/");
  const findings = findUnsafeIdentifiers(
    `phoneE164: "+${phone}"; externalJid: "${lid}@lid"; email: "${email}"; path: "${localPath}";`,
    "fixture.ts",
  );

  assert.deepEqual(
    findings.map(({ kind }) => kind).sort(),
    ["email", "local-user-path", "phone", "whatsapp-lid"],
  );
});

test("aceita emails e caminhos relativos reservados para fixtures", () => {
  const findings = findUnsafeIdentifiers(
    [
      'email: "pessoa@example.test";',
      'path: ".data/fixture";',
      'mac: "/Users/voce/Projects/produto";',
      'linux: "/home/threadmark/.local/share/threadmark";',
      'group: "fixture@g.us";',
      'participant: "fixture@s.whatsapp.net";',
    ].join("\n"),
    "fixture.ts",
  );

  assert.deepEqual(findings, []);
});

test("reprova email e caminho absoluto ligados a uma pessoa", () => {
  const email = ["pessoa", "empresa.invalid"].join("@");
  const localPath = ["", "Users", "nome-pessoal", "Projects"].join("/");

  assert.deepEqual(
    findUnsafeIdentifiers(`email: "${email}"; path: "${localPath}";`, "fixture.ts")
      .map((finding) => finding.kind),
    ["email", "local-user-path"],
  );
});
