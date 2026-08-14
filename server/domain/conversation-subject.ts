const DIRECT_CONVERSATION_SUFFIXES = ["@s.whatsapp.net", "@lid"] as const;

export function isDirectConversationJid(externalJid: string): boolean {
  const normalizedJid = externalJid.trim().toLowerCase();
  return DIRECT_CONVERSATION_SUFFIXES.some((suffix) =>
    normalizedJid.endsWith(suffix),
  );
}

export function normalizeConversationSubject(
  subject: string,
  externalJid: string,
): string {
  const normalizedSubject = subject.trim();
  if (!isDirectConversationJid(externalJid)) return normalizedSubject;

  const localPart = externalJid.trim().split("@")[0]?.trim() ?? "";
  const identifier = localPart.split(":")[0]?.trim() ?? "";
  if (!identifier) return normalizedSubject;

  const placeholder = /^(?:grupo|conversa\s+privada)\s+(.+)$/iu.exec(
    normalizedSubject,
  );
  const placeholderIdentifier = placeholder?.[1]?.trim();
  if (
    placeholderIdentifier === localPart ||
    placeholderIdentifier === identifier ||
    normalizedSubject === externalJid.trim()
  ) {
    return identifier;
  }

  return normalizedSubject;
}
