import assert from "node:assert/strict";
import test from "node:test";

import {
  isAffirmativePreviewConfirmation,
  isRetryInstruction,
  isTaskContinuationInstruction,
} from "../server/agent/confirmation-intent.js";

test("reconhece confirmações naturais e coloquiais de uma prévia", () => {
  for (const message of [
    "Pode criar",
    "Pode fazer",
    "Pode daler",
    "Manda bala",
    "Eu confirmo",
    "Eu confirmooo!",
    "Sim",
    "Beleza, pode seguir",
    "Pode vincular isso agora",
  ]) {
    assert.equal(isAffirmativePreviewConfirmation(message), true, message);
  }
});

test("continuação de tarefa não confunde uma nova ordem explícita com retry", () => {
  for (const message of [
    "Tenta novamente",
    "Continue",
    "Pode seguir",
    "Pode seguir com os ajustes",
    "Você consegue aplicar as mudanças?",
    "Eu confirmooo!",
    "Manda bala",
  ]) {
    assert.equal(isTaskContinuationInstruction(message), true, message);
  }
  for (const message of ["Crie o ticket com as mensagens", "Pode criar o ticket #240"]) {
    assert.equal(isTaskContinuationInstruction(message), false, message);
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

test("reconhece repetição sem tratá-la isoladamente como confirmação", () => {
  for (const message of ["Tenta novamente", "Tente de novo", "Tentar outra vez agora"]) {
    assert.equal(isRetryInstruction(message), true, message);
    assert.equal(isAffirmativePreviewConfirmation(message), false, message);
  }
});
