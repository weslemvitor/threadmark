import { isIP } from "node:net";

import { z } from "zod";

export const MAX_TIMEOUT_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TEMPLATE_BYTES = 64 * 1_024;
export const MAX_RESPONSE_BYTES = 64 * 1_024;

const FORBIDDEN_PUBLIC_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "idempotency-key",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "transfer-encoding",
  "x-api-key",
  "x-threadmark-idempotency-key",
]);

const FORBIDDEN_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "transfer-encoding",
]);

export const secretReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "Referência de segredo inválida");

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "Chave de idempotência inválida");

export const timeoutSchema = z
  .number()
  .int()
  .min(250)
  .max(MAX_TIMEOUT_MS)
  .default(DEFAULT_TIMEOUT_MS);

export const publicHeaderSchema = z
  .object({
    name: z.string().trim().min(1).max(128).refine(isHeaderName, "Header inválido"),
    value: z.string().max(8_192),
  })
  .strict()
  .superRefine((header, context) => {
    if (FORBIDDEN_PUBLIC_HEADERS.has(header.name.toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Headers sensíveis devem usar uma referência do cofre local",
      });
    }
    if (/\r|\n/.test(header.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "O valor do header não pode conter quebras de linha",
      });
    }
  });

export const secretHeaderSchema = z
  .object({
    name: z.string().trim().min(1).max(128).refine(isHeaderName, "Header inválido"),
    secretRef: secretReferenceSchema,
  })
  .strict()
  .superRefine((header, context) => {
    if (FORBIDDEN_HEADER_NAMES.has(header.name.toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Este header é controlado pelo Threadmark",
      });
    }
  });

export const safeHttpUrlSchema = z
  .url()
  .max(2_000)
  .transform((value) => new URL(value))
  .superRefine((url, context) => {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "Use uma URL HTTP ou HTTPS" });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Credenciais não podem fazer parte da URL",
      });
    }
    if (url.hash) {
      context.addIssue({ code: "custom", message: "A URL não pode conter fragmento" });
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|auth|credential|password|secret|signature|token)/i.test(key)) {
        context.addIssue({
          code: "custom",
          message: "Segredos não podem ser incluídos nos parâmetros da URL",
        });
      }
    }
  });

export function assertUrlAllowed(url: URL, allowPrivateNetwork = false): void {
  if (allowPrivateNetwork) return;
  const hostname = normaliseHostname(url.hostname);
  if (isLocalHostname(hostname) || isPrivateOrReservedIp(hostname)) {
    throw new TypeError(
      "URLs locais, privadas ou reservadas são bloqueadas por padrão.",
    );
  }
}

export function isPrivateOrReservedIp(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return isPrivateOrReservedIpv4(value);
  if (version === 6) return isPrivateOrReservedIpv6(value);
  return false;
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function normaliseHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0" ||
    hostname === "0.0.0.0"
  );
}

function isPrivateOrReservedIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 192 && b === 88) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPrivateOrReservedIpv6(value: string): boolean {
  const hextets = expandIpv6(value);
  if (!hextets) return true;
  const [first, second] = hextets as [number, number, ...number[]];
  const unspecifiedOrLoopback = hextets.slice(0, 7).every((part) => part === 0);
  if (unspecifiedOrLoopback && (hextets[7] === 0 || hextets[7] === 1)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  if (first === 0x0100 && second === 0) return true; // discard-only 100::/64
  if (first === 0x2002) return true; // deprecated 6to4 can tunnel private IPv4

  const embeddedIpv4 = ipv4FromEmbeddedHextets(hextets);
  if (embeddedIpv4 && isPrivateOrReservedIpv4(embeddedIpv4)) return true;
  const nat64 = first === 0x0064 && second === 0xff9b;
  if (nat64) {
    const translated = ipv4FromLastHextets(hextets);
    if (isPrivateOrReservedIpv4(translated)) return true;
  }
  return false;
}

function expandIpv6(value: string): number[] | null {
  const normalised = value.toLowerCase();
  const [left = "", right = "", extra] = normalised.split("::");
  if (extra !== undefined) return null;
  const leftParts = ipv6Parts(left);
  const rightParts = ipv6Parts(right);
  if (!leftParts || !rightParts) return null;
  if (!normalised.includes("::")) return leftParts.length === 8 ? leftParts : null;
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 1) return null;
  return [...leftParts, ...Array.from({ length: missing }, () => 0), ...rightParts];
}

function ipv6Parts(value: string): number[] | null {
  if (!value) return [];
  const raw = value.split(":");
  const parts: number[] = [];
  for (const item of raw) {
    if (item.includes(".")) {
      const octets = item.split(".").map(Number);
      if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return null;
      parts.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
    parts.push(Number.parseInt(item, 16));
  }
  return parts;
}

function ipv4FromEmbeddedHextets(hextets: number[]): string | null {
  const ipv4Compatible = hextets.slice(0, 6).every((part) => part === 0);
  const ipv4Mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  return ipv4Compatible || ipv4Mapped ? ipv4FromLastHextets(hextets) : null;
}

function ipv4FromLastHextets(hextets: number[]): string {
  const high = hextets[6] ?? 0;
  const low = hextets[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
