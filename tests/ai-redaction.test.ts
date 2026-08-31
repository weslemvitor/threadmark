import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveAiInput,
  redactSensitiveAiText,
} from "../server/agent/ai-redaction.js";

test("contexto enviado à IA preserva nomes de campos e remove valores secretos", () => {
  const credentialUrl = [
    "postgresql://readonly:database-password",
    "db.internal:5432/app",
  ].join("@");
  const redacted = redactSensitiveAiText([
    "OPENAI_API_KEY=sk-example-secret-value",
    `DATABASE_URL='${credentialUrl}'`,
    '"client_secret": "client-secret-value"',
    "O ticket possui 1.791 pessoas impactadas e 92 envios.",
  ].join("\n"));

  assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(redacted, /DATABASE_URL=\[REDACTED\]/);
  assert.match(redacted, /"client_secret": \[REDACTED\]/);
  assert.match(redacted, /1\.791 pessoas impactadas e 92 envios/);
  assert.doesNotMatch(redacted, /example-secret-value|database-password|client-secret-value/);
});

test("chaves conhecidas soltas e blocos privados nunca chegam ao modelo", () => {
  const redacted = redactSensitiveAiText([
    "Use sk-1234567890abcdefghijklmnop para testar.",
    "-----BEGIN PRIVATE KEY-----",
    "private-material",
    "-----END PRIVATE KEY-----",
  ].join("\n"));

  assert.doesNotMatch(redacted, /sk-1234567890|private-material/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /CHAVE PRIVADA REMOVIDA/);
});

test("payload completo da IA remove segredos de qualquer campo textual aninhado", () => {
  const secret = "sk-1234567890abcdefghijklmnop";
  const input = {
    operatorInstructions: `consulte TOKEN=${secret}`,
    accountName: `Conta ${secret}`,
    messages: [{
      id: "message-1",
      attachments: [{
        fileName: `evidencia-${secret}.txt`,
        extractedText: [
          "DATABASE_URL=postgresql://user:password",
          "db.internal/app",
        ].join("@"),
      }],
    }],
    images: [{ fileName: `print-${secret}.png` }],
    currentOperator: {
      displayName: `Operador ${secret}`,
      role: "owner",
    },
    availableTools: [{
      id: "tool-1",
      description: `client_secret=${secret}`,
    }],
    credentials: {
      apiKey: "opaque-secret-value",
    },
    ordinaryMetadata: {
      count: 1_791,
      enabled: true,
      missing: null,
    },
  };

  const redacted = redactSensitiveAiInput(input);
  const serialized = JSON.stringify(redacted);

  assert.doesNotMatch(serialized, /sk-1234567890|postgresql:\/\/user:password/);
  assert.match(redacted.operatorInstructions, /TOKEN=\[REDACTED\]/);
  assert.match(redacted.messages[0]!.attachments[0]!.fileName, /\[REDACTED\]/);
  assert.equal(
    redacted.messages[0]!.attachments[0]!.extractedText,
    "DATABASE_URL=[REDACTED]",
  );
  assert.equal(redacted.credentials.apiKey, "[REDACTED]");
  assert.deepEqual(redacted.ordinaryMetadata, {
    count: 1_791,
    enabled: true,
    missing: null,
  });
  assert.notEqual(redacted, input);
});
