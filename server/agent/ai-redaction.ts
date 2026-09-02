import type { InvestigationThreadInput } from "./types.js";

const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(\b(?:[A-Z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_.-]*|DATABASE_URL|CLICKHOUSE_URL)\b["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`,
  "giu",
);
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/giu;
const WELL_KNOWN_SECRET = /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[oprsu]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|vck_[A-Za-z0-9_]{12,})\b/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu;
const SENSITIVE_FIELD_NAME = /(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|ACCESSKEY|PRIVATEKEY|CLIENTSECRET|DATABASEURL|CLICKHOUSEURL)/u;

export function redactSensitiveAiText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[CHAVE PRIVADA REMOVIDA]")
    .replace(CREDENTIAL_URL, "$1[REDACTED]$3")
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(WELL_KNOWN_SECRET, "[REDACTED]");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveFieldName(value: string): boolean {
  return SENSITIVE_FIELD_NAME.test(value.replaceAll(/[^a-z0-9]/giu, "").toUpperCase());
}

function redactSensitiveAiValue(value: unknown, fieldName?: string): unknown {
  if (typeof value === "string") {
    return fieldName && isSensitiveFieldName(fieldName)
      ? "[REDACTED]"
      : redactSensitiveAiText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveAiValue(item));
  }
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactSensitiveAiValue(item, key),
    ]),
  );
}

/**
 * Clones a plain AI payload while redacting every nested textual value.
 * This is intentionally schema-agnostic so new prompt metadata cannot bypass
 * redaction merely because it was added outside the known message fields.
 */
export function redactSensitiveAiInput<T>(input: T): T {
  return redactSensitiveAiValue(input) as T;
}

export function redactInvestigationThreadInput(
  input: InvestigationThreadInput,
): InvestigationThreadInput {
  return redactSensitiveAiInput(input);
}
