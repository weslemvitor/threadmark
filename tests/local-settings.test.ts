import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalSettingsFile,
  mergeConfiguredIdentities,
} from "../server/runtime/local-settings.js";

test("configuração local distingue legado do override explícito da equipe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadmark-settings-"));
  try {
    const file = new LocalSettingsFile(path.join(root, "settings.json"));
    const initial = await file.read();
    assert.deepEqual(initial, {
      monitoredGroupJids: [],
      staffIdentities: [],
      staffIdentitiesConfigured: false,
      staffRestartRequired: false,
    });
    assert.deepEqual(
      mergeConfiguredIdentities(["5511900000001"], ["5511900000002"]),
      ["5511900000001", "5511900000002"],
    );

    await file.write({
      ...initial,
      staffIdentities: [],
      staffIdentitiesConfigured: true,
      staffRestartRequired: true,
    });
    const saved = await file.read();
    assert.equal(saved.staffIdentitiesConfigured, true);
    assert.equal(saved.staffRestartRequired, true);
    assert.deepEqual(saved.staffIdentities, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
