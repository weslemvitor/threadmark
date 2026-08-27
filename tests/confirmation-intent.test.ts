import assert from "node:assert/strict";
import test from "node:test";

import { isAffirmativePreviewConfirmation } from "../server/agent/confirmation-intent.js";

test("reconhece confirmações naturais e coloquiais de uma prévia", () => {
  for (const message of [
    "Pode criar",
    "Pode fazer",
    "Pode daler",
    "Manda bala",
    "Eu confirmo",
    "Sim",
    "Beleza, pode seguir",
    "Pode vincular isso agora",
  ]) {
    assert.equal(isAffirmativePreviewConfirmation(message), true, message);
  }
});

test("não transforma negação, condição ou correção em confirmação", () => {
  for (const message of [
    "Não pode criar",
    "Pode criar, mas troca o título",
    "Sim, porém antes altera a categoria",
    "Talvez possa fazer",
    "Na verdade quero mudar a descrição",
    "Pode me explicar o que será criado?",
  ]) {
    assert.equal(isAffirmativePreviewConfirmation(message), false, message);
  }
});
