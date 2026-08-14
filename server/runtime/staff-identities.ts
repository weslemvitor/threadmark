import type { SupportStore } from "../domain/index.js";
import { normalizeJid } from "../whatsapp/index.js";

export function resolveConfiguredStaffIdentities(
  store: SupportStore,
  identities: readonly string[],
): {
  participantIds: string[];
  policyIdentities: string[];
} {
  const externalJids = [...new Set(identities.map(normalizeJid).filter(Boolean))];
  const phoneE164s = externalJids.flatMap((identity) => {
    if (!identity.endsWith("@s.whatsapp.net")) return [];
    const digits = identity.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
    return digits.length >= 8 ? [`+${digits}`] : [];
  });
  const participantIds = store.findParticipantIds({
    externalJids,
    phoneE164s: [...new Set(phoneE164s)],
  });
  return {
    participantIds,
    policyIdentities: [
      ...new Set([
        ...externalJids,
        ...store.getParticipantExternalJids(participantIds),
      ]),
    ],
  };
}
