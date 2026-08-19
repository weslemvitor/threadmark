import { MAX_TEMPLATE_BYTES } from "./validation.js";

const TOKEN_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,7})\s*}}/g;
const EXACT_TOKEN_PATTERN = /^{{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,7})\s*}}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype", "secrets"]);
const MAX_TEMPLATE_DEPTH = 12;
const MAX_TEMPLATE_NODES = 1_000;

export type IntegrationTemplateVariables = Readonly<Record<string, unknown>>;

export function validateJsonTemplate(value: unknown): void {
  let nodes = 0;
  walk(value, 0, (current) => {
    nodes += 1;
    if (nodes > MAX_TEMPLATE_NODES) {
      throw new TypeError("O template excede o limite de elementos.");
    }
    if (typeof current === "string") validateTemplateString(current);
    if (typeof current === "number" && !Number.isFinite(current)) {
      throw new TypeError("O template precisa conter apenas valores JSON válidos.");
    }
    if (["undefined", "bigint", "function", "symbol"].includes(typeof current)) {
      throw new TypeError("O template precisa conter apenas valores JSON válidos.");
    }
  });
  const serialised = JSON.stringify(value);
  if (serialised === undefined) {
    throw new TypeError("O template precisa conter um corpo JSON válido.");
  }
  const bytes = Buffer.byteLength(serialised, "utf8");
  if (bytes > MAX_TEMPLATE_BYTES) {
    throw new TypeError("O template excede o limite de tamanho.");
  }
}

export function renderJsonTemplate(
  template: unknown,
  variables: IntegrationTemplateVariables,
): unknown {
  validateJsonTemplate(template);
  const rendered = transform(template, 0, (current) => {
    if (typeof current !== "string") return current;
    const exact = current.match(EXACT_TOKEN_PATTERN)?.[1];
    if (exact) return readTemplateValue(variables, exact);
    return current.replace(TOKEN_PATTERN, (_token, path: string) => {
      const value = readTemplateValue(variables, path);
      if (value === null) return "";
      if (["string", "number", "boolean"].includes(typeof value)) return String(value);
      throw new TypeError(`O valor de ${path} não pode ser inserido dentro de um texto.`);
    });
  });
  if (Buffer.byteLength(JSON.stringify(rendered), "utf8") > MAX_TEMPLATE_BYTES) {
    throw new TypeError("O conteúdo renderizado excede o limite de tamanho.");
  }
  return rendered;
}

function validateTemplateString(value: string): void {
  let count = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    count += 1;
    validatePath(match[1] ?? "");
    if (count > 64) throw new TypeError("O template possui variáveis demais.");
  }
  const residue = value.replace(TOKEN_PATTERN, "");
  if (residue.includes("{{") || residue.includes("}}")) {
    throw new TypeError("Template inválido ou variável não permitida.");
  }
}

function readTemplateValue(variables: IntegrationTemplateVariables, path: string): unknown {
  validatePath(path);
  let current: unknown = variables;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      throw new TypeError(`A variável ${path} não está disponível neste fluxo.`);
    }
    current = current[segment];
  }
  return cloneJsonValue(current);
}

function validatePath(path: string): void {
  const segments = path.split(".");
  if (!path || segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new TypeError("O template referencia uma variável não permitida.");
  }
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isPlainRecord(value)) {
    throw new TypeError("A variável do template precisa ser um valor JSON.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
  );
}

function walk(value: unknown, depth: number, visit: (value: unknown) => void): void {
  if (depth > MAX_TEMPLATE_DEPTH) throw new TypeError("O template é profundo demais.");
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, visit);
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(key.toLowerCase())) {
        throw new TypeError("O template possui uma propriedade não permitida.");
      }
      walk(item, depth + 1, visit);
    }
  }
}

function transform(
  value: unknown,
  depth: number,
  mapper: (value: unknown) => unknown,
): unknown {
  if (depth > MAX_TEMPLATE_DEPTH) throw new TypeError("O template é profundo demais.");
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, depth + 1, mapper));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, transform(item, depth + 1, mapper)]),
    );
  }
  return mapper(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
