import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAnalysisCategories,
  normalizeCategoriesForAnalysis,
  normalizeCategory,
} from "../server/domain/category-policy.js";

test("normaliza categorias úteis e elimina canal, origem e limitações de mídia", () => {
  assert.deepEqual(
    normalizeAnalysisCategories({
      contactReason: ["Pergunta", "WhatsApp", "Mensagem sem contexto"],
      productArea: [
        "Envio de mensagens",
        "Dashboard",
        "Nome da empresa",
        "Áudio sem transcrição",
      ],
      platform: ["WhatsApp", "Meta Ads", "Google", "GA4", "PDF sem leitura"],
      symptom: [
        "Dados divergentes",
        "Mensagens não enviadas",
        "Print sem leitura",
      ],
    }),
    {
      contactReason: ["Dúvida"],
      productArea: ["CRM"],
      platform: ["Meta", "Google Ads", "GA4"],
      symptom: ["Dados incorretos"],
    },
  );
});

test("deduplica aliases sem eliminar sintomas reais do CRM", () => {
  assert.deepEqual(
    normalizeAnalysisCategories({
      contactReason: ["Dúvida", "duvida", "Questionamento"],
      productArea: ["CRM", "Messages", "Campanhas", "Base de clientes"],
      platform: ["Meta", "Facebook Ads", "Google Analytics 4"],
      symptom: ["Mensagens não enviadas", "Base de clientes não carrega"],
    }),
    {
      contactReason: ["Dúvida"],
      productArea: ["CRM"],
      platform: ["Meta", "GA4"],
      symptom: ["Mensagens não enviadas"],
    },
  );
});

test("rejeita rótulo inválido isolado e canoniza conexão de anúncios", () => {
  assert.equal(normalizeCategory("symptom", "Imagem sem leitura"), null);
  assert.equal(normalizeCategory("symptom", "Sem transcrição do áudio"), null);
  assert.equal(normalizeCategory("symptom", "Áudio recebido"), null);
  assert.equal(normalizeCategory("symptom", "Saudação"), null);
  assert.equal(normalizeCategory("symptom", "Solicitação não identificada"), null);
  assert.equal(normalizeCategory("platform", "Web UI"), null);
  assert.equal(normalizeCategory("product", "Suporte ACME"), null);
  assert.equal(normalizeCategory("product", "Área aleatória"), null);
  assert.equal(normalizeCategory("product", "Cliente XPTO"), null);
  assert.equal(normalizeCategory("symptom", "Mensagem recebida"), null);
  assert.equal(normalizeCategory("symptom", "Compatibilidade não confirmada"), null);
  assert.equal(normalizeCategory("symptom", "Erro ao ler PDF"), null);
  assert.deepEqual(normalizeCategory("reason", "Dúvida não detalhada"), {
    facet: "reason",
    label: "Dúvida",
    slug: "duvida",
  });
  assert.deepEqual(normalizeCategory("symptom", "Falha ao enviar áudio"), {
    facet: "symptom",
    label: "Falha ao enviar áudio",
    slug: "falha-ao-enviar-audio",
  });
  assert.deepEqual(
    normalizeCategory("product", "Integração de contas de anúncio"),
    {
      facet: "product",
      label: "Conexão de contas de anúncio",
      slug: "conexao-de-contas-de-anuncio",
    },
  );
});

test("não cria taxonomia para falso ticket social ou informativo", () => {
  const categories = {
    contactReason: ["Dúvida"],
    productArea: ["CRM"],
    platform: ["Meta"],
    symptom: ["Dados incorretos"],
  };
  assert.deepEqual(
    normalizeCategoriesForAnalysis({
      createTicket: false,
      relation: "uncertain",
      categories,
    }),
    { contactReason: [], productArea: [], platform: [], symptom: [] },
  );
  assert.deepEqual(
    normalizeCategoriesForAnalysis({
      createTicket: true,
      relation: "social",
      categories,
    }),
    { contactReason: [], productArea: [], platform: [], symptom: [] },
  );
});

test("aceita categoria personalizada somente quando ela existe no catálogo da instalação", () => {
  const categories = {
    contactReason: [],
    productArea: ["Checkout"],
    platform: [],
    symptom: ["Cupom não aplicado"],
  };
  assert.deepEqual(normalizeAnalysisCategories(categories), {
    contactReason: [],
    productArea: [],
    platform: [],
    symptom: [],
  });
  assert.deepEqual(
    normalizeAnalysisCategories(categories, {
      contactReason: ["Dúvida", "Problema", "Solicitação"],
      productArea: ["Checkout"],
      platform: [],
      symptom: ["Cupom não aplicado"],
    }),
    categories,
  );
});
