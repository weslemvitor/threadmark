import type { ChannelConfig, ChannelMappingField } from "@/shared/channels";

export const CHANNEL_DEFAULT_CONFIG: ChannelConfig = {
  format: "standard", mapping: {}, timestampFormat: "iso", roleMapping: {}, eventTypeMapping: {},
  authentication: "bearer", signatureHeader: "X-Channel-Signature", signatureEncoding: "hex",
  signatureAlgorithm: "sha256", signaturePrefix: "", conversationScope: "group", monitored: true,
};

export const CHANNEL_SAMPLE = JSON.stringify({
  eventId: "example-event-1", eventType: "message.created", eventOccurredAt: "2026-10-16T12:00:00Z",
  messageId: "example-message-1", conversationId: "example-conversation-1", conversationTitle: "Atendimento de exemplo",
  authorId: "example-contact-1", authorName: "Pessoa cliente", authorRole: "customer",
  body: "Preciso de ajuda com meu pedido.", occurredAt: "2026-10-16T12:00:00Z",
}, null, 2);

export const CHANNEL_FIELDS: Array<{key: ChannelMappingField; label: string; hint: string; optional?: boolean}> = [
  {key: "eventId", label: "ID do evento", hint: "Identifica este envio. Reentregas devem manter o mesmo ID."},
  {key: "messageId", label: "ID da mensagem", hint: "Identifica a mensagem, não a conversa inteira."},
  {key: "conversationId", label: "ID da conversa", hint: "Mensagens do mesmo atendimento devem compartilhar este valor."},
  {key: "body", label: "Texto da mensagem", hint: "Escolha o conteúdo escrito pelo autor."},
  {key: "authorId", label: "ID do autor", hint: "Use uma identidade estável. O nome não deve ser usado como ID."},
  {key: "authorName", label: "Nome do autor", hint: "Como o autor aparecerá no histórico."},
  {key: "authorRole", label: "Papel do autor", hint: "Distingue mensagens de clientes e da equipe."},
  {key: "occurredAt", label: "Data da mensagem", hint: "Quando a mensagem foi escrita na origem."},
  {key: "conversationTitle", label: "Título da conversa", hint: "Opcional. Sem título, será exibido o ID da conversa.", optional: true},
  {key: "eventType", label: "Tipo do evento", hint: "Sem este campo, o evento é tratado como uma mensagem nova.", optional: true},
  {key: "eventOccurredAt", label: "Data da alteração", hint: "Use a data da revisão ao receber edições ou exclusões.", optional: true},
  {key: "threadId", label: "ID do tópico", hint: "Separa tópicos dentro de uma mesma conversa.", optional: true},
  {key: "replyToMessageId", label: "Mensagem respondida", hint: "ID da mensagem original citada na resposta.", optional: true},
  {key: "externalUrl", label: "Link na origem", hint: "Link HTTPS para abrir o atendimento original.", optional: true},
  {key: "attachments", label: "Anexos", hint: "Lista de referências com id, name, mimeType e url HTTPS.", optional: true},
];

export function parseChannelSample(text: string): {payload: unknown; error: string | null} {
  if (!text.trim()) return {payload: null, error: null};
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) return {payload: null, error: "O exemplo deve ter no máximo 256 KiB."};
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {payload: null, error: "Cole um objeto JSON, começando com { e terminando com }."};
    return {payload, error: null};
  } catch { return {payload: null, error: "O JSON está incompleto ou inválido. Confira aspas, vírgulas e chaves."}; }
}

export function channelValueAt(payload: unknown, path?: string): unknown {
  if (!path) return undefined;
  let value = payload;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function channelSamplePaths(payload: unknown): string[] {
  const paths: string[] = [];
  function visit(value: unknown, prefix: string, depth: number) {
    if (paths.length >= 400 || depth > 10) return;
    if (prefix && (value === null || typeof value !== "object" || Array.isArray(value))) paths.push(prefix);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) continue;
      const next = prefix ? `${prefix}.${key}` : key;
      if (next.length <= 300) visit(child, next, depth + 1);
    }
  }
  visit(payload, "", 0);
  return paths;
}

export function channelValueLabel(value: unknown): string {
  if (value === undefined) return "Campo não encontrado neste exemplo";
  if (value === null) return "Vazio (null)";
  if (Array.isArray(value)) return `${value.length} item(ns)`;
  if (typeof value === "object") return "Objeto JSON";
  return String(value).slice(0, 100) || "Texto vazio";
}

export function channelSetupError(error: unknown): string {
  if (!(error instanceof Error)) return "Não foi possível concluir. Confira a configuração e tente novamente.";
  if (!("details" in error) || !Array.isArray(error.details)) return error.message;
  const fields = error.details.flatMap((issue: {path?: unknown[]}) => {
    const key = issue.path?.at(-1);
    return typeof key === "string" ? [CHANNEL_FIELDS.find(field => field.key === key)?.label ?? key] : [];
  });
  return fields.length ? `Confira estes campos: ${[...new Set(fields)].join(", ")}. Verifique se o caminho e o formato do valor correspondem ao JSON.` : error.message;
}
