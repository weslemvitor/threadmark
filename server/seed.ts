import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "./db/index.js";
import {
  SupportStore,
  type CreateTicketInput,
} from "./domain/index.js";
import {
  loadConfig,
  type SupportConfig,
} from "./runtime/config.js";

const MINUTE_MS = 60_000;

interface DemoMessage {
  minutesAgo: number;
  text: string;
  messageType?: "text" | "image" | "document";
  triageKind?: "demand" | "uncertain" | "continuation";
}

interface DemoTicket {
  id: string;
  groupId: string;
  senderId: string;
  affectedStoreId?: string;
  title: string;
  summary: string;
  status: CreateTicketInput["status"];
  priority: CreateTicketInput["priority"];
  needsReview?: boolean;
  categoryIds: string[];
  messages: DemoMessage[];
}

interface DemoResolvedCase {
  id: string;
  groupId: string;
  senderId: string;
  affectedStoreId?: string;
  title: string;
  question: string;
  answer: string;
  confirmation: string;
  categoryIds: string[];
  daysAgo: number;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString();
}

function daysAgo(days: number): string {
  return minutesAgo(days * 24 * 60);
}

export function assertPresentationDataDirectory(config: SupportConfig): void {
  if (basename(config.dataDir) !== "presentation") {
    throw new Error(
      "O seed de apresentação só pode usar um SUPPORT_DATA_DIR terminado em /presentation.",
    );
  }
}

function buildSimplePdf(lines: string[]): Buffer {
  const escapeText = (value: string) => value.replace(/[\\()]/g, "\\$&");
  const commands = [
    "BT",
    "/F1 15 Tf",
    "72 750 Td",
    ...lines.flatMap((line, index) => [
      ...(index ? ["0 -26 Td"] : []),
      `(${escapeText(line)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePresentationAttachments(config: SupportConfig) {
  const directory = join(config.attachmentsDir, "presentation");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const feedPdf = buildSimplePdf([
    "Amostra de feed - Loja Exemplo Gama",
    "g:id = EXEMPLO-CADEIRA-AZUL",
    "g:item_group_id = EXEMPLO-CADEIRA",
    "g:color = Azul | g:size = Unico",
  ]);
  const feedPath = join(directory, "amostra-feed-loja-exemplo.pdf");
  writeFileSync(feedPath, feedPdf, { mode: 0o600 });

  const popupSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#f4f1ec"/>
  <rect x="88" y="68" width="1104" height="584" rx="28" fill="#ffffff" stroke="#d9d2c7" stroke-width="3"/>
  <text x="134" y="128" font-family="Arial, sans-serif" font-size="25" fill="#77706a">Loja Exemplo Delta · captura do popup publicado</text>
  <rect x="332" y="190" width="616" height="370" rx="24" fill="#f8efe8" stroke="#b99079" stroke-width="3"/>
  <text x="640" y="315" text-anchor="middle" font-family="Times New Roman, serif" font-size="44" fill="#44372f">Ganhe 10% na primeira compra</text>
  <text x="640" y="370" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#77685f">A fonte publicada ficou diferente do editor.</text>
  <rect x="500" y="420" width="280" height="64" rx="12" fill="#6f8761"/>
  <text x="640" y="461" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">QUERO MEU CUPOM</text>
</svg>`;
  const popupPath = join(directory, "popup-loja-exemplo.svg");
  writeFileSync(popupPath, popupSvg, { mode: 0o600 });

  return {
    feed: {
      path: feedPath,
      size: statSync(feedPath).size,
      sha: sha256(feedPdf),
    },
    popup: {
      path: popupPath,
      size: statSync(popupPath).size,
      sha: sha256(popupSvg),
    },
  };
}

function seedConversationTicket(
  store: SupportStore,
  input: DemoTicket,
  beforeTicket?: (messages: ReturnType<SupportStore["upsertMessage"]>[]) => void,
) {
  const messages = input.messages.map((message, index) =>
    store.upsertMessage({
      id: `${input.id}-message-${index + 1}`,
      externalId: `presentation-${input.id}-${index + 1}`,
      providerMessageId: `presentation-${input.id}-${index + 1}`,
      groupId: input.groupId,
      senderId: input.senderId,
      occurredAt: minutesAgo(message.minutesAgo),
      text: message.text,
      messageType: message.messageType ?? "text",
      triageKind: message.triageKind ?? (index ? "continuation" : "demand"),
    }),
  );
  beforeTicket?.(messages);
  const firstMessageAt = Math.max(...input.messages.map((message) => message.minutesAgo));
  return {
    ticket: store.createTicket({
      id: input.id,
      groupId: input.groupId,
      sourceMessageId: messages[0]!.id,
      messageIds: messages.slice(1).map((message) => message.id),
      affectedStoreId: input.affectedStoreId,
      title: input.title,
      summary: input.summary,
      status: input.status,
      priority: input.priority,
      confidence: null,
      needsReview: input.needsReview ?? false,
      categories: input.categoryIds.map((categoryId) => ({
        categoryId,
        source: "rule",
        confidence: null,
      })),
      actor: "Ambiente de apresentação",
      createdAt: minutesAgo(firstMessageAt),
    }),
    messages,
  };
}

function seedResolvedCase(
  store: SupportStore,
  staffId: string,
  input: DemoResolvedCase,
): void {
  const baseMinutes = input.daysAgo * 24 * 60;
  const question = store.upsertMessage({
    id: `${input.id}-question`,
    externalId: `presentation-${input.id}-question`,
    providerMessageId: `presentation-${input.id}-question`,
    groupId: input.groupId,
    senderId: input.senderId,
    occurredAt: minutesAgo(baseMinutes),
    text: input.question,
    messageType: "text",
    triageKind: "demand",
  });
  const answer = store.upsertMessage({
    id: `${input.id}-answer`,
    externalId: `presentation-${input.id}-answer`,
    providerMessageId: `presentation-${input.id}-answer`,
    groupId: input.groupId,
    senderId: staffId,
    occurredAt: minutesAgo(baseMinutes - 20),
    text: input.answer,
    messageType: "text",
  });
  const confirmation = store.upsertMessage({
    id: `${input.id}-confirmation`,
    externalId: `presentation-${input.id}-confirmation`,
    providerMessageId: `presentation-${input.id}-confirmation`,
    groupId: input.groupId,
    senderId: input.senderId,
    occurredAt: minutesAgo(baseMinutes - 45),
    text: input.confirmation,
    messageType: "text",
    triageKind: "information",
  });
  const ticket = store.createTicket({
    id: `${input.id}-ticket`,
    groupId: input.groupId,
    sourceMessageId: question.id,
    messageIds: [answer.id, confirmation.id],
    affectedStoreId: input.affectedStoreId,
    title: input.title,
    summary: input.question,
    status: "resolved",
    priority: "normal",
    confidence: null,
    needsReview: false,
    categories: input.categoryIds.map((categoryId) => ({
      categoryId,
      source: "manual",
      confidence: null,
    })),
    actor: "Operador de demonstração",
    createdAt: minutesAgo(baseMinutes),
  });
  store.recordSentResponse({
    id: `${input.id}-sent-response`,
    ticketId: ticket.id,
    messageId: answer.id,
    body: input.answer,
    sentAt: minutesAgo(baseMinutes - 20),
    capturedAt: minutesAgo(baseMinutes - 19),
  });
  store.recordResolution({
    ticketId: ticket.id,
    summary: "Orientação confirmada pelo cliente e preparada para reutilização.",
    outcome: input.confirmation,
    validatedBy: "Operador de demonstração",
    validatedAt: minutesAgo(baseMinutes - 45),
  });
}

export function seedPresentationData(config = loadConfig()): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("O seed de apresentação não pode ser executado em produção.");
  }
  assertPresentationDataDirectory(config);

  const assets = writePresentationAttachments(config);
  const database = createDatabase(config.databasePath);
  const store = new SupportStore(database);

  try {
    const account = store.upsertAccount({
      id: "presentation-account-commercial",
      phoneNumber: "+12025550100",
      displayName: "Conta Threadmark — Apresentação",
    });

    const organizationAlpha = store.upsertClient({
      id: "presentation-client-example-organization-alpha",
      name: "Organização Exemplo Alfa",
      slug: "apresentacao-organizacao-exemplo-alfa",
      kind: "agency",
      notes: "Agência de demonstração com três operações de ecommerce.",
    });
    const organizationBeta = store.upsertClient({
      id: "presentation-client-example-organization-beta",
      name: "Organização Exemplo Beta",
      slug: "apresentacao-organizacao-exemplo-beta",
      kind: "agency",
      notes: "Agência de demonstração com foco em mídia e audiências.",
    });
    const shopGamma = store.upsertClient({
      id: "presentation-client-example-shop-gamma",
      name: "Loja Exemplo Gama",
      slug: "apresentacao-loja-exemplo-gama",
      kind: "ecommerce",
    });
    const shopDelta = store.upsertClient({
      id: "presentation-client-example-shop-delta",
      name: "Loja Exemplo Delta",
      slug: "apresentacao-loja-exemplo-delta",
      kind: "ecommerce",
    });
    const shopEpsilon = store.upsertClient({
      id: "presentation-client-example-shop-epsilon",
      name: "Loja Exemplo Épsilon",
      slug: "apresentacao-loja-exemplo-epsilon",
      kind: "ecommerce",
    });

    const operationAlpha = store.upsertStore({
      id: "presentation-store-example-operation-alpha",
      clientId: organizationAlpha.id,
      name: "Operação Exemplo Alfa",
      businessId: "demo-operation-alpha",
      platform: "VTEX",
    });
    const operationBeta = store.upsertStore({
      id: "presentation-store-example-operation-beta",
      clientId: organizationAlpha.id,
      name: "Operação Exemplo Beta",
      businessId: "demo-operation-beta",
      platform: "Nuvemshop",
    });
    const operationGamma = store.upsertStore({
      id: "presentation-store-example-operation-gamma",
      clientId: organizationAlpha.id,
      name: "Operação Exemplo Gama",
      businessId: "demo-operation-gamma",
      platform: "Shopify",
    });
    const operationDelta = store.upsertStore({
      id: "presentation-store-example-operation-delta",
      clientId: organizationBeta.id,
      name: "Operação Exemplo Delta",
      businessId: "demo-operation-delta",
      platform: "Wake",
    });
    store.upsertStore({
      id: "presentation-store-example-operation-epsilon",
      clientId: organizationBeta.id,
      name: "Operação Exemplo Épsilon",
      businessId: "demo-operation-epsilon",
      platform: "WooCommerce",
    });
    const shopGammaStore = store.upsertStore({
      id: "presentation-store-example-shop-gamma",
      clientId: shopGamma.id,
      name: "Loja Exemplo Gama",
      businessId: "demo-shop-gamma",
      platform: "Shopify",
    });
    const shopDeltaStore = store.upsertStore({
      id: "presentation-store-example-shop-delta",
      clientId: shopDelta.id,
      name: "Loja Exemplo Delta",
      businessId: "demo-shop-delta",
      platform: "WooCommerce",
    });
    const shopEpsilonStore = store.upsertStore({
      id: "presentation-store-example-shop-epsilon",
      clientId: shopEpsilon.id,
      name: "Loja Exemplo Épsilon",
      businessId: "demo-shop-epsilon",
      platform: "Wake",
    });

    const groupInputs = [
      ["alpha", organizationAlpha.id, "Atendimento + Organização Exemplo Alfa"],
      ["beta", organizationBeta.id, "Atendimento + Organização Exemplo Beta"],
      ["gamma", shopGamma.id, "Atendimento + Loja Exemplo Gama"],
      ["delta", shopDelta.id, "Atendimento + Loja Exemplo Delta"],
      ["epsilon", shopEpsilon.id, "Atendimento + Loja Exemplo Épsilon"],
    ] as const;
    const groups = Object.fromEntries(
      groupInputs.map(([key, clientId, subject], index) => [
        key,
        store.upsertGroup({
          id: `presentation-group-${key}`,
          accountId: account.id,
          clientId,
          externalJid: `12036390000000${index + 1}@g.us`,
          subject,
          monitored: true,
          historyOldestAt: daysAgo(120 - index * 12),
          historyNewestAt: minutesAgo(22 + index * 17),
          historyComplete: false,
        }),
      ]),
    ) as Record<(typeof groupInputs)[number][0], { id: string }>;

    // +1 202-555-0100–0199 é uma faixa reservada para exemplos fictícios.
    const operatorParticipant = store.upsertParticipant({
      id: "presentation-participant-operator",
      externalJid: "12025550100@s.whatsapp.net",
      phoneE164: "+12025550100",
      displayName: "Operador Exemplo",
    });
    const participant01 = store.upsertParticipant({
      id: "presentation-participant-example-01",
      externalJid: "12025550101@s.whatsapp.net",
      phoneE164: "+12025550101",
      displayName: "Participante Exemplo 01 — Organização Exemplo Alfa",
    });
    const participant02 = store.upsertParticipant({
      id: "presentation-participant-example-02",
      externalJid: "12025550102@s.whatsapp.net",
      phoneE164: "+12025550102",
      displayName: "Participante Exemplo 02 — Organização Exemplo Alfa",
    });
    const participant03 = store.upsertParticipant({
      id: "presentation-participant-example-03",
      externalJid: "12025550103@s.whatsapp.net",
      phoneE164: "+12025550103",
      displayName: "Participante Exemplo 03 — Organização Exemplo Beta",
    });
    const participant04 = store.upsertParticipant({
      id: "presentation-participant-example-04",
      externalJid: "12025550104@s.whatsapp.net",
      phoneE164: "+12025550104",
      displayName: "Participante Exemplo 04 — Loja Exemplo Gama",
    });
    const participant05 = store.upsertParticipant({
      id: "presentation-participant-example-05",
      externalJid: "12025550105@s.whatsapp.net",
      phoneE164: "+12025550105",
      displayName: "Participante Exemplo 05 — Loja Exemplo Delta",
    });
    const participant06 = store.upsertParticipant({
      id: "presentation-participant-example-06",
      externalJid: "12025550106@s.whatsapp.net",
      phoneE164: "+12025550106",
      displayName: "Participante Exemplo 06 — Loja Exemplo Épsilon",
    });
    store.setStaffMember(operatorParticipant.id, "Operador Exemplo", true);

    for (const [groupId, participants] of [
      [groups.alpha.id, [operatorParticipant.id, participant01.id, participant02.id]],
      [groups.beta.id, [operatorParticipant.id, participant03.id]],
      [groups.gamma.id, [operatorParticipant.id, participant04.id]],
      [groups.delta.id, [operatorParticipant.id, participant05.id]],
      [groups.epsilon.id, [operatorParticipant.id, participant06.id]],
    ] as const) {
      for (const participantId of participants) {
        store.addGroupParticipant(groupId, participantId);
      }
    }

    const categoryDefinitions = [
      ["reason-question", "reason", "duvida", "Dúvida", "#6b8afd"],
      ["reason-problem", "reason", "problema", "Problema", "#ef6a5b"],
      ["product-dashboard", "product", "dashboard", "Dashboard", "#4e9a83"],
      ["product-orders", "product", "pedidos", "Pedidos", "#e27c4f"],
      ["product-campaigns", "product", "campanhas", "Campanhas", "#6876db"],
      ["product-audience", "product", "publicos", "Públicos", "#9770c9"],
      ["product-feed", "product", "feed", "Feed de produtos", "#d49a42"],
      ["product-popup", "product", "popup", "Popup", "#bf6f92"],
      ["product-integration", "product", "integracao", "Integração", "#478da8"],
      ["platform-vtex", "platform", "vtex", "VTEX", "#315f9e"],
      ["platform-nuvemshop", "platform", "nuvemshop", "Nuvemshop", "#4d73d8"],
      ["platform-shopify", "platform", "shopify", "Shopify", "#6b9c45"],
      ["platform-wake", "platform", "wake", "Wake", "#6948ad"],
      ["platform-woocommerce", "platform", "woocommerce", "WooCommerce", "#8a5a9e"],
      ["symptom-metric", "symptom", "divergencia-metrica", "Divergência de métrica", "#d29a3d"],
      ["symptom-missing-orders", "symptom", "pedidos-ausentes", "Pedidos ausentes", "#ef6a5b"],
      ["symptom-zero-revenue", "symptom", "receita-zerada", "Receita zerada", "#cc5a68"],
      ["symptom-visual", "symptom", "divergencia-visual", "Divergência visual", "#b85e91"],
      ["symptom-credentials", "symptom", "credencial-invalida", "Credencial inválida", "#c45e52"],
    ] as const;
    const categories = Object.fromEntries(
      categoryDefinitions.map(([key, facet, slug, label, color]) => [
        key,
        store.upsertCategory({
          id: `presentation-category-${key}`,
          facet,
          slug,
          label,
          color,
        }).id,
      ]),
    ) as Record<(typeof categoryDefinitions)[number][0], string>;

    seedResolvedCase(store, operatorParticipant.id, {
      id: "presentation-resolved-metrics",
      groupId: groups.alpha.id,
      senderId: participant01.id,
      affectedStoreId: operationAlpha.id,
      title: "Por que Total de clientes pode diferir de Novos + Recorrentes?",
      question: "O Total de clientes precisa ser exatamente a soma de Novos e Recorrentes?",
      answer: "Não compare as três métricas como uma soma automática. Primeiro alinhe período, fuso, filtros e regra de identificação do cliente. Total considera clientes únicos no recorte, enquanto Novos e Recorrentes dependem das regras de classificação do período. Se a diferença continuar, envie business ID e print dos mesmos filtros.",
      confirmation: "Perfeito, ajustamos o período e agora conseguimos explicar a diferença.",
      categoryIds: [categories["reason-question"], categories["product-dashboard"], categories["symptom-metric"]],
      daysAgo: 14,
    });
    seedResolvedCase(store, operatorParticipant.id, {
      id: "presentation-resolved-missing-orders",
      groupId: groups.alpha.id,
      senderId: participant02.id,
      affectedStoreId: operationBeta.id,
      title: "Quais dados enviar quando pedidos não aparecem?",
      question: "O que vocês precisam para conferir pedidos que estão na plataforma mas não no dashboard?",
      answer: "Envie a loja ou business ID, plataforma, período com fuso, IDs de dois ou três pedidos, status na plataforma e um print com horário. Com isso conseguimos separar atraso, credencial, regra de status e divergência de período sem expor dados desnecessários.",
      confirmation: "Entendido, esse checklist resolveu o levantamento com o cliente.",
      categoryIds: [categories["reason-problem"], categories["product-orders"], categories["symptom-missing-orders"]],
      daysAgo: 11,
    });
    seedResolvedCase(store, operatorParticipant.id, {
      id: "presentation-resolved-feed",
      groupId: groups.gamma.id,
      senderId: participant04.id,
      affectedStoreId: shopGammaStore.id,
      title: "Como validar SKUs e produto pai no feed?",
      question: "Como identificamos no feed se cor e tamanho estão saindo por SKU?",
      answer: "Confira uma família de produtos: cada variação deve ter g:id próprio e as variações do mesmo produto devem compartilhar o g:item_group_id. Compare também cor, tamanho, disponibilidade e URL antes de concluir que o feed está correto.",
      confirmation: "Conferimos três produtos e ficou claro. Obrigada!",
      categoryIds: [categories["reason-question"], categories["product-feed"], categories["platform-shopify"]],
      daysAgo: 8,
    });
    seedResolvedCase(store, operatorParticipant.id, {
      id: "presentation-resolved-popup",
      groupId: groups.delta.id,
      senderId: participant05.id,
      affectedStoreId: shopDeltaStore.id,
      title: "O que enviar quando o popup muda depois de publicado?",
      question: "O popup ficou diferente na loja. Quais evidências vocês precisam?",
      answer: "Envie a URL, print do editor e da página publicada, navegador e dispositivo, horário, nome da campanha e alterações recentes no tema. Isso permite comparar configuração, cache e CSS da loja antes de sugerir uma correção.",
      confirmation: "Ótimo, com esse roteiro conseguimos reproduzir e corrigir.",
      categoryIds: [categories["reason-problem"], categories["product-popup"], categories["symptom-visual"]],
      daysAgo: 5,
    });

    const metrics = seedConversationTicket(store, {
      id: "presentation-ticket-customer-metrics",
      groupId: groups.alpha.id,
      senderId: participant01.id,
      affectedStoreId: operationAlpha.id,
      title: "Novos + recorrentes não fecha com o Total de clientes",
      summary: "Operação Exemplo Alfa compara 1.248 clientes totais com 312 novos e 781 recorrentes no mesmo painel.",
      status: "new",
      priority: "normal",
      categoryIds: [categories["reason-question"], categories["product-dashboard"], categories["symptom-metric"]],
      messages: [
        { minutesAgo: 252, text: "Bom dia! Na Operação Exemplo Alfa o Total de clientes mostra 1.248 neste mês." },
        { minutesAgo: 251, text: "Novos está 312 e recorrentes 781, usando o mesmo filtro." },
        { minutesAgo: 250, text: "Por que a soma não chega no Total de clientes? Qual número devemos apresentar?" },
      ],
    });
    void metrics;

    seedConversationTicket(store, {
      id: "presentation-ticket-missing-orders",
      groupId: groups.alpha.id,
      senderId: participant02.id,
      affectedStoreId: operationBeta.id,
      title: "Pedidos de ontem ausentes no dashboard",
      summary: "Operação Exemplo Beta tem 18 pedidos aprovados na Nuvemshop e 11 no dashboard.",
      status: "triage",
      priority: "high",
      categoryIds: [categories["reason-problem"], categories["product-orders"], categories["platform-nuvemshop"], categories["symptom-missing-orders"]],
      messages: [
        { minutesAgo: 247, text: "Outra coisa: na Operação Exemplo Beta os pedidos de ontem não aparecem todos." },
        { minutesAgo: 246, text: "Na Nuvemshop existem 18 aprovados e no dashboard aparecem 11. Posso mandar os IDs." },
      ],
    });

    seedConversationTicket(store, {
      id: "presentation-ticket-zero-revenue",
      groupId: groups.alpha.id,
      senderId: participant01.id,
      affectedStoreId: operationGamma.id,
      title: "Campanha com cliques e receita zerada",
      summary: "Operação Exemplo Gama registra investimento e cliques, mas nenhuma receita atribuída desde ontem.",
      status: "in_progress",
      priority: "high",
      categoryIds: [categories["reason-problem"], categories["product-campaigns"], categories["platform-shopify"], categories["symptom-zero-revenue"]],
      messages: [
        { minutesAgo: 176, text: "Na Operação Exemplo Gama a campanha de remarketing tem 436 cliques desde ontem, mas a receita segue zerada." },
        { minutesAgo: 174, text: "A Shopify tem vendas no período. Isso precisa de uma investigação mais profunda?" },
      ],
    });

    seedConversationTicket(store, {
      id: "presentation-ticket-audience-drop",
      groupId: groups.beta.id,
      senderId: participant03.id,
      affectedStoreId: operationDelta.id,
      title: "Público reduziu após salvar os filtros",
      summary: "Operação Exemplo Delta viu a audiência cair de 42 mil para 8 mil pessoas após editar filtros.",
      status: "new",
      priority: "normal",
      categoryIds: [categories["reason-question"], categories["product-audience"], categories["platform-wake"]],
      messages: [
        { minutesAgo: 118, text: "O público da Operação Exemplo Delta tinha cerca de 42 mil pessoas antes de salvarmos um filtro de produto visto." },
        { minutesAgo: 116, text: "Depois de salvar caiu para 8 mil. O filtro substitui o anterior ou cruza as condições?" },
      ],
    });

    seedConversationTicket(store, {
      id: "presentation-ticket-feed-skus",
      groupId: groups.gamma.id,
      senderId: participant04.id,
      affectedStoreId: shopGammaStore.id,
      title: "Feed separa cor e tamanho por SKU?",
      summary: "Loja Exemplo Gama quer confirmar se as variações são exportadas individualmente no feed.",
      status: "new",
      priority: "normal",
      categoryIds: [categories["reason-question"], categories["product-feed"], categories["platform-shopify"]],
      messages: [
        { minutesAgo: 83, text: "Vocês conseguem confirmar se o feed leva cada cor e tamanho como um SKU separado?", messageType: "text" },
        { minutesAgo: 82, text: "Anexei uma amostra com uma cadeira azul para testarmos.", messageType: "document" },
      ],
    }, (messages) => {
      store.upsertAttachment({
        id: "presentation-attachment-feed",
        messageId: messages[1]!.id,
        kind: "pdf",
        mimeType: "application/pdf",
        fileName: "amostra-feed-loja-exemplo.pdf",
        localPath: assets.feed.path,
        sizeBytes: assets.feed.size,
        sha256: assets.feed.sha,
        sourceKey: "presentation-feed-pdf",
        extractedText: "g:id=EXEMPLO-CADEIRA-AZUL; g:item_group_id=EXEMPLO-CADEIRA; g:color=Azul; g:size=Unico",
        available: true,
      });
    });

    seedConversationTicket(store, {
      id: "presentation-ticket-popup-font",
      groupId: groups.delta.id,
      senderId: participant05.id,
      affectedStoreId: shopDeltaStore.id,
      title: "Fonte do popup mudou após publicação",
      summary: "Loja Exemplo Delta relata que a tipografia publicada não corresponde ao editor.",
      status: "waiting_customer",
      priority: "normal",
      categoryIds: [categories["reason-problem"], categories["product-popup"], categories["platform-woocommerce"], categories["symptom-visual"]],
      messages: [
        { minutesAgo: 48, text: "O texto do popup ficou com outra fonte depois da publicação. No editor estava certo.", messageType: "image", triageKind: "uncertain" },
        { minutesAgo: 47, text: "Segue o print da página. Se precisar mando também a URL e o print do editor.", messageType: "image" },
      ],
    }, (messages) => {
      store.upsertAttachment({
        id: "presentation-attachment-popup",
        messageId: messages[1]!.id,
        kind: "image",
        mimeType: "image/svg+xml",
        fileName: "popup-loja-exemplo.svg",
        localPath: assets.popup.path,
        sizeBytes: assets.popup.size,
        sha256: assets.popup.sha,
        sourceKey: "presentation-popup-screenshot",
        extractedText: "Ganhe 10% na primeira compra. A fonte publicada ficou diferente do editor.",
        available: true,
      });
    });

    seedConversationTicket(store, {
      id: "presentation-ticket-wake-password",
      groupId: groups.epsilon.id,
      senderId: participant06.id,
      affectedStoreId: shopEpsilonStore.id,
      title: "Pedidos pararam após troca da senha da Wake",
      summary: "Loja Exemplo Épsilon trocou a credencial da plataforma e não recebe novos pedidos desde então.",
      status: "triage",
      priority: "urgent",
      needsReview: true,
      categoryIds: [categories["reason-problem"], categories["product-integration"], categories["platform-wake"], categories["symptom-credentials"]],
      messages: [
        { minutesAgo: 24, text: "Trocamos a senha do usuário da Wake ontem e desde então nenhum pedido novo apareceu." },
        { minutesAgo: 22, text: "Temos pedidos aprovados hoje. Vocês precisam que a gente atualize a credencial em algum lugar?" },
      ],
    });

    store.setRuntimeStatus({
      state: "offline",
      startedAt: null,
      lastHeartbeatAt: null,
      lastSyncAt: minutesAgo(18),
      connectedAccount: "Conta Threadmark — Ambiente de apresentação",
      lastError: null,
    });

    const counts = database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM clients) AS clients,
          (SELECT COUNT(*) FROM client_stores WHERE active = 1) AS stores,
          (SELECT COUNT(*) FROM whatsapp_groups) AS groups,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM tickets WHERE status NOT IN ('resolved', 'archived')) AS open_tickets,
          (SELECT COUNT(*) FROM investigation_jobs) AS investigations`,
      )
      .get() as Record<string, number>;
    console.log(
      `Apresentação pronta em ${config.databasePath}: ${counts.clients} clientes, ${counts.stores} lojas, ${counts.groups} grupos, ${counts.messages} mensagens, ${counts.open_tickets} tickets abertos e ${counts.investigations} investigações.`,
    );
  } finally {
    database.close();
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && fileURLToPath(import.meta.url) === resolve(entry));
}

if (isEntrypoint()) {
  seedPresentationData();
}
