import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  isolatedCodexConfigArgs,
  prepareIsolatedCodexHome,
} from "../server/agent/codex-runner.js";

const execFileAsync = promisify(execFile);

test("prompt efetivo automático não carrega AGENTS, skills ou caminhos pessoais", async (context) => {
  const codexBin = process.env.CODEX_BIN ?? "codex";
  try {
    await execFileAsync(codexBin, ["--version"], { timeout: 10_000 });
  } catch {
    context.skip("Codex CLI não está instalado neste ambiente.");
    return;
  }

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "threadmark-codex-prompt-isolation-"),
  );
  const sourceHome = path.join(temporary, "personal-codex-home");
  const workspace = path.join(temporary, "private-workspace");
  const runDir = await mkdtemp(path.join(os.tmpdir(), "threadmark-codex-run-"));
  const globalSentinel = "THREADMARK_PRIVATE_GLOBAL_AGENT_SENTINEL";
  const projectSentinel = "THREADMARK_PRIVATE_PROJECT_AGENT_SENTINEL";

  try {
    await mkdir(sourceHome, { recursive: true, mode: 0o700 });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(sourceHome, "AGENTS.md"), globalSentinel);
    await writeFile(path.join(workspace, "AGENTS.md"), projectSentinel);

    const isolatedHome = await prepareIsolatedCodexHome(runDir, sourceHome);
    const { stdout } = await execFileAsync(
      codexBin,
      [
        "debug",
        "prompt-input",
        ...isolatedCodexConfigArgs(isolatedHome),
        "isolation-probe",
      ],
      {
        cwd: runDir,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: path.join(runDir, "home"),
          CODEX_HOME: isolatedHome,
        },
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const promptInput = JSON.parse(stdout) as Array<{ type?: unknown }>;
    const serialized = JSON.stringify(promptInput);

    assert.equal(serialized.includes(globalSentinel), false);
    assert.equal(serialized.includes(projectSentinel), false);
    assert.equal(serialized.includes(sourceHome), false);
    assert.equal(serialized.includes(workspace), false);
    assert.equal(serialized.includes("### Available skills"), false);
    assert.ok(
      promptInput.every((item) => item.type === "message"),
      "o prompt automático não deve expor ferramentas",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
