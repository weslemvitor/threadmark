import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

// A syntactically valid value used only to equalize the expensive password
// verification path when an unknown username is submitted.
export const DUMMY_PASSWORD_HASH =
  "$scrypt$n=16384,r=8,p=1$VGhyZWFkbWFyay1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return [
    "",
    "scrypt",
    `n=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  const derivedKey = await deriveKey(password, parsed.salt, parsed.parameters);
  return (
    derivedKey.length === parsed.hash.length &&
    timingSafeEqual(derivedKey, parsed.hash)
  );
}

interface ScryptParameters {
  n: number;
  r: number;
  p: number;
}

function parsePasswordHash(encodedHash: string): {
  parameters: ScryptParameters;
  salt: Buffer;
  hash: Buffer;
} | null {
  const [empty, algorithm, encodedParameters, encodedSalt, encodedKey, extra] =
    encodedHash.split("$");
  if (
    empty !== "" ||
    algorithm !== "scrypt" ||
    !encodedParameters ||
    !encodedSalt ||
    !encodedKey ||
    extra !== undefined
  ) {
    return null;
  }

  const match = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(encodedParameters);
  if (!match) return null;

  const parameters = {
    n: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
  };
  if (
    parameters.n !== SCRYPT_N ||
    parameters.r !== SCRYPT_R ||
    parameters.p !== SCRYPT_P
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const hash = Buffer.from(encodedKey, "base64url");
    if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) return null;
    return { parameters, salt, hash };
  } catch {
    return null;
  }
}

function deriveKey(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: parameters.n,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}
