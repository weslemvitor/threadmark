import assert from "node:assert/strict";
import test from "node:test";

import { createCompletionSoundController } from "../app/features/threadmark-ai/completion-sound.js";

test("som aguarda o AudioContext sair de suspended antes de tocar", async () => {
  let state = "suspended";
  let gainCreated = 0;
  let oscillatorsCreated = 0;
  const gain = {
    gain: {
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
    },
    connect() {},
  };
  const controller = createCompletionSoundController(() => ({
    get state() { return state; },
    async resume() {
      await Promise.resolve();
      state = "running";
    },
    currentTime: 10,
    destination: {},
    createGain() {
      gainCreated += 1;
      return gain;
    },
    createOscillator() {
      oscillatorsCreated += 1;
      return {
        type: "sine",
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    },
  }));

  assert.equal(await controller.play(), true);
  assert.equal(state, "running");
  assert.equal(gainCreated, 1);
  assert.equal(oscillatorsCreated, 2);
});

test("som falha silenciosamente quando o navegador bloqueia o resume", async () => {
  const controller = createCompletionSoundController(() => ({
    state: "suspended",
    async resume() { throw new Error("autoplay bloqueado"); },
    currentTime: 0,
    destination: {},
    createGain() { throw new Error("não deve tocar"); },
    createOscillator() { throw new Error("não deve tocar"); },
  }));

  assert.equal(await controller.play(), false);
});
