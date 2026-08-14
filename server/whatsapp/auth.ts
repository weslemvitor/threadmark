import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  useMultiFileAuthState as createMultiFileAuthState,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "baileys";

export interface PersistentAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
}

/**
 * Baileys 7 still labels its multi-file helper as unsuitable for a remote,
 * multi-process production service. This app is deliberately single-user and
 * local, so we encapsulate that helper and harden every directory/file write.
 */
export async function loadPersistentAuthState(
  directory: string,
): Promise<PersistentAuthState> {
  const authDirectory = resolve(directory);
  await prepareSecureDirectory(authDirectory);
  await hardenAuthTree(authDirectory);

  const auth = await createMultiFileAuthState(authDirectory);
  const originalKeys = auth.state.keys;
  let authMutationQueue = Promise.resolve();
  const runSecureMutation = (mutation: () => Promise<void>): Promise<void> => {
    const operation = authMutationQueue.then(async () => {
      await mutation();
      await hardenAuthTree(authDirectory);
    });
    authMutationQueue = operation.catch(() => undefined);
    return operation;
  };
  const secureKeys: AuthenticationState["keys"] = {
    get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      return originalKeys.get(type, ids);
    },
    set(data: SignalDataSet) {
      return runSecureMutation(async () => {
        await originalKeys.set(data);
      });
    },
  };

  if (originalKeys.clear) {
    secureKeys.clear = () => runSecureMutation(async () => {
      await originalKeys.clear?.();
    });
  }

  await hardenAuthTree(authDirectory);
  return {
    state: {
      creds: auth.state.creds,
      keys: secureKeys,
    },
    saveCreds: () => runSecureMutation(auth.saveCreds),
  };
}

/**
 * Removes only the local Baileys credentials so a fresh QR can be requested.
 * Conversation history, attachments and the operational SQLite database live
 * outside this directory and are deliberately left untouched.
 */
export async function resetPersistentAuthState(directory: string): Promise<void> {
  const authDirectory = resolve(directory);
  await prepareSecureDirectory(authDirectory);
  await hardenAuthTree(authDirectory);
  const entries = await readdir(authDirectory);
  await Promise.all(
    entries.map((entry) =>
      rm(resolve(authDirectory, entry), { recursive: true, force: true }),
    ),
  );
  await chmod(authDirectory, 0o700);
}

async function prepareSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("WhatsApp auth path must be a real local directory");
  }
  await chmod(directory, 0o700);
}

async function hardenAuthTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed in WhatsApp auth state");
      }
      if (entry.isDirectory()) {
        await chmod(path, 0o700);
        await hardenAuthTree(path);
        return;
      }
      if (entry.isFile()) {
        await chmod(path, 0o600);
      }
    }),
  );
  await chmod(directory, 0o700);
}
