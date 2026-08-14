const PARTICIPANT_PLACEHOLDER_PATTERN = /^participante(?:\s+|$)/i;
const PHONE_LIKE_PATTERN = /^[+\d\s().-]+$/;

export function isParticipantPlaceholderDisplayName(value: string): boolean {
  return PARTICIPANT_PLACEHOLDER_PATTERN.test(value.trim());
}

export function isTechnicalParticipantDisplayName(
  value: string,
  identities: readonly (string | null | undefined)[] = [],
): boolean {
  const candidate = value.trim();
  if (!candidate || isParticipantPlaceholderDisplayName(candidate)) return true;

  const normalized = candidate.toLocaleLowerCase("pt-BR");
  if (
    identities.some((identity) => {
      const normalizedIdentity = identity?.trim().toLocaleLowerCase("pt-BR");
      if (!normalizedIdentity) return false;
      return (
        normalized === normalizedIdentity ||
        normalized === normalizedIdentity.split("@")[0]
      );
    })
  ) {
    return true;
  }

  return (
    PHONE_LIKE_PATTERN.test(candidate) &&
    candidate.replace(/\D/g, "").length >= 7
  );
}

export function isHumanParticipantDisplayName(
  value: string,
  identities: readonly (string | null | undefined)[] = [],
): boolean {
  return !isTechnicalParticipantDisplayName(value, identities);
}

function participantDisplayNameQuality(
  value: string,
  identities: readonly (string | null | undefined)[],
): number {
  if (isParticipantPlaceholderDisplayName(value)) return 0;
  if (isHumanParticipantDisplayName(value, identities)) return 3;
  return PHONE_LIKE_PATTERN.test(value.trim()) ? 2 : 1;
}

export function preferredParticipantDisplayName(input: {
  externalJid: string;
  phoneE164?: string | null;
  incoming: string;
  existing?: string | null;
}): string {
  const identities = [input.externalJid, input.phoneE164];
  const incoming = isParticipantPlaceholderDisplayName(input.incoming)
    ? input.phoneE164?.trim() || input.externalJid
    : input.incoming.trim();
  const existing = input.existing?.trim();
  if (
    existing &&
    participantDisplayNameQuality(existing, identities) >
      participantDisplayNameQuality(incoming, identities)
  ) {
    return existing;
  }
  return incoming;
}
