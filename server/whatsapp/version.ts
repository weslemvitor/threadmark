import {
  fetchLatestBaileysVersion,
  type WAVersion,
} from "baileys";

export const THREADMARK_FALLBACK_WA_VERSION: WAVersion = [
  2,
  3000,
  1_043_857_760,
];

type VersionLookup = () => Promise<{
  version: WAVersion;
  isLatest: boolean;
}>;

export async function resolveWhatsAppWebVersion(
  lookup: VersionLookup = () =>
    fetchLatestBaileysVersion({
      signal: AbortSignal.timeout(5_000),
    }),
): Promise<WAVersion> {
  try {
    const result = await lookup();
    if (result.isLatest && isValidWhatsAppVersion(result.version)) {
      return result.version;
    }
  } catch {
    // A rede não pode impedir a captura local de iniciar. O fallback acompanha
    // a versão compatível fixada no pacote Baileys usado pelo ThreadMark.
  }

  return [...THREADMARK_FALLBACK_WA_VERSION] as WAVersion;
}

function isValidWhatsAppVersion(version: WAVersion): boolean {
  return (
    version.length === 3 &&
    version.every(
      (part) => Number.isSafeInteger(part) && part >= 0,
    )
  );
}
