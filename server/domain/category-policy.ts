import type { CategoryFacet } from "../../shared/contracts.js";
import type {
  AnalysisCategoryCatalog,
  SupportAnalysis,
} from "../agent/types.js";

export interface NormalizedCategory {
  facet: CategoryFacet;
  label: string;
  slug: string;
}

const BLOCKED_EXACT_LABELS = new Set([
  "whatsapp",
  "whatsapp business",
  "canal whatsapp",
  "grupo whatsapp",
  "audio",
  "imagem",
  "print",
  "screenshot",
  "pdf",
  "documento",
  "anexo",
  "arquivo",
  "midia",
  "foto",
  "video",
  "mensagem sem contexto",
  "sem contexto",
  "contexto insuficiente",
  "falta de contexto",
  "informacao insuficiente",
  "sem informacao",
  "nao identificado",
  "nao especificado",
  "desconhecido",
  "indefinido",
  "outros",
  "geral",
  "saudacao",
  "elogio",
  "social",
  "conversa social",
  "conversa informal",
  "interacao social",
  "comunicado informativo",
  "atendimento",
  "suporte",
  "suporte tecnico",
  "empresa",
  "organizacao",
  "nome da empresa",
  "relato de problema",
  "relato de problema tecnico",
  "problema tecnico",
]);

const INVALID_SOURCE_OR_CHANNEL =
  /\b(?:whats?\s*app|canal|grupo|conversa|cliente|empresa|organizacao)\b/u;
const INVALID_MEDIA_LIMITATION =
  /\b(?:audio|imagem|print|screenshot|pdf|documento|anexo|arquivo|midia|foto|video)\b.*\b(?:sem|nao|indisponivel|impossivel)\b.*\b(?:transcricao|transcrever|transcrito|leitura|ler|lido|analise|analisar|processamento|processar|conteudo|contexto)\b/u;
const INVALID_REVERSED_MEDIA_LIMITATION =
  /\b(?:sem|nao|indisponivel|impossivel)\b.*\b(?:transcricao|transcrever|transcrito|leitura|ler|lido|analise|analisar|processamento|processar|conteudo|contexto)\b.*\b(?:audio|imagem|print|screenshot|pdf|documento|anexo|arquivo|midia|foto|video)\b/u;
const INVALID_CONTEXT_LIMITATION =
  /\b(?:mensagem|conversa|conteudo|informacao)\b.*\b(?:sem|falta|insuficiente|ausente)\b.*\bcontexto\b/u;
const INVALID_UNCERTAINTY =
  /\b(?:nao identificado|nao identificada|nao especificado|nao especificada|nao detalhado|nao detalhada|desconhecido|desconhecida|indefinido|indefinida)\b/u;
const MEDIA_FORMAT =
  /\b(?:audio|imagem|print|screenshot|pdf|documento|anexo|arquivo|midia|foto|video)\b/u;
const MEDIA_PROBLEM_SIGNAL =
  /\b(?:falha|erro|problema|invalido|invalida|corrompido|corrompida|mudo|muda|travando|nao carrega|nao abre|nao envia|nao grava|nao anexa|nao processa|nao consigo)\b/u;
const GENERIC_PLATFORM_LABELS = new Set([
  "app",
  "aplicacao",
  "ecommerce",
  "site",
  "sistema",
  "web",
  "web ui",
]);

const FACET_LIMITS: Record<"reason" | "product" | "platform" | "symptom", number> = {
  reason: 1,
  product: 1,
  platform: 3,
  symptom: 1,
};

const STRICT_CATALOG_FACETS = new Set<CategoryFacet>([
  "product",
  "platform",
  "symptom",
]);

const FACET_ALIASES: Partial<Record<CategoryFacet, ReadonlyMap<string, string>>> = {
  product: new Map([
    ["dashboard", "Dashboard"],
    ["painel", "Dashboard"],
    ["relatorio", "Dashboard"],
    ["relatorios", "Dashboard"],
    ["crm", "CRM"],
    ["messages", "CRM"],
    ["mensagens", "CRM"],
    ["envio de mensagens", "CRM"],
    ["envios de mensagens", "CRM"],
    ["campanha", "CRM"],
    ["campanhas", "CRM"],
    ["email marketing", "CRM"],
    ["e mail marketing", "CRM"],
    ["jornada", "CRM"],
    ["jornadas", "CRM"],
    ["automacao", "CRM"],
    ["automacoes", "CRM"],
    ["carrinho abandonado", "CRM"],
    ["cdp", "CRM"],
    ["base de clientes", "CRM"],
    ["bases de clientes", "CRM"],
    ["conexao de conta de anuncio", "Conexão de contas de anúncio"],
    ["conexao de contas de anuncio", "Conexão de contas de anúncio"],
    ["conectar conta de anuncio", "Conexão de contas de anúncio"],
    ["conectar contas de anuncio", "Conexão de contas de anúncio"],
    ["integracao de conta de anuncio", "Conexão de contas de anúncio"],
    ["integracao de contas de anuncio", "Conexão de contas de anúncio"],
    ["integracao", "Integrações"],
    ["integracoes", "Integrações"],
    ["integracao de ecommerce", "Integrações"],
    ["integracoes de ecommerce", "Integrações"],
    ["pedido", "Pedidos"],
    ["pedidos", "Pedidos"],
    ["feed", "Feed"],
    ["feed de produtos", "Feed"],
    ["catalogo", "Feed"],
    ["catalogo de produtos", "Feed"],
    ["publico", "Públicos"],
    ["publicos", "Públicos"],
    ["audiencia", "Públicos"],
    ["audiencias", "Públicos"],
    ["segmentacao", "Públicos"],
    ["popup", "Popup"],
    ["popup de captura", "Popup"],
    ["captura de leads", "Popup"],
    ["tracking", "Tracking"],
    ["rastreamento", "Tracking"],
    ["atribuicao", "Tracking"],
    ["pixel", "Tracking"],
    ["acesso", "Acesso"],
    ["login", "Acesso"],
    ["usuarios", "Acesso"],
    ["permissoes", "Acesso"],
  ]),
  platform: new Map([
    ["meta", "Meta"],
    ["meta ads", "Meta"],
    ["facebook", "Meta"],
    ["facebook ads", "Meta"],
    ["google", "Google Ads"],
    ["google ads", "Google Ads"],
    ["adwords", "Google Ads"],
    ["ga4", "GA4"],
    ["google analytics", "GA4"],
    ["google analytics 4", "GA4"],
    ["google merchant", "Google Merchant Center"],
    ["google merchant center", "Google Merchant Center"],
    ["tiktok", "TikTok Ads"],
    ["tiktok ads", "TikTok Ads"],
    ["vtex", "VTEX"],
    ["shopify", "Shopify"],
    ["nuvemshop", "Nuvemshop"],
    ["wake", "Wake"],
    ["woocommerce", "WooCommerce"],
    ["woo commerce", "WooCommerce"],
    ["magazord", "Magazord"],
    ["tray", "Tray"],
    ["yampi", "Yampi"],
    ["w tec", "W Tec"],
    ["admcli", "ADMCLI"],
    ["rd station", "RD Station"],
  ]),
  symptom: new Map([
    ["dados incorretos", "Dados incorretos"],
    ["dados errados", "Dados incorretos"],
    ["dados divergentes", "Dados incorretos"],
    ["divergencia de dados", "Dados incorretos"],
    ["discrepancia de dados", "Dados incorretos"],
    ["divergencia de metrica", "Dados incorretos"],
    ["metricas incorretas", "Dados incorretos"],
    ["receita incorreta", "Dados incorretos"],
    ["pedidos ausentes", "Pedidos ausentes"],
    ["pedido ausente", "Pedidos ausentes"],
    ["pedidos nao sincronizados", "Pedidos ausentes"],
    ["pedidos duplicados", "Pedidos duplicados"],
    ["mensagens nao enviadas", "Mensagens não enviadas"],
    ["mensagem nao enviada", "Mensagens não enviadas"],
    ["mensagens nao recebidas", "Mensagens não recebidas"],
    ["mensagem nao recebida", "Mensagens não recebidas"],
    ["mensagem de jornada nao recebida", "Mensagens não recebidas"],
    ["campanhas duplicadas", "Campanhas duplicadas"],
    ["campanha duplicada", "Campanhas duplicadas"],
    ["rascunhos duplicados", "Campanhas duplicadas"],
    ["campanhas vazias", "Campanhas vazias"],
    ["campanha vazia", "Campanhas vazias"],
    ["criacao inesperada de campanhas", "Campanhas criadas inesperadamente"],
    ["campanhas criadas inesperadamente", "Campanhas criadas inesperadamente"],
    ["criacao multipla inesperada", "Campanhas criadas inesperadamente"],
    ["falha de integracao", "Falha de integração"],
    ["integracao indisponivel", "Falha de integração"],
    ["credencial invalida", "Credencial inválida"],
    ["credenciais invalidas", "Credencial inválida"],
    ["acesso indisponivel", "Acesso indisponível"],
    ["sem acesso", "Acesso indisponível"],
    ["dados nao atualizados", "Dados não atualizados"],
    ["dados desatualizados", "Dados não atualizados"],
    ["dados nao carregados", "Dados não carregados"],
    ["base de clientes nao carrega", "Dados não carregados"],
    ["conversas nao salvas", "Conversas não salvas"],
    ["historico ausente", "Histórico ausente"],
    ["telefone nao reconhecido", "Telefone não reconhecido"],
    ["falha ao gravar audio", "Falha ao gravar áudio"],
    ["falha na gravacao de audio", "Falha ao gravar áudio"],
    ["falha ao enviar audio", "Falha ao enviar áudio"],
    ["falha no envio de audio", "Falha ao enviar áudio"],
    ["perda de assertividade", "Perda de assertividade"],
    ["receita zerada", "Receita zerada"],
    ["divergencia visual", "Divergência visual"],
    ["feed invalido", "Feed inválido"],
    ["produtos ausentes", "Produtos ausentes"],
    ["publico vazio", "Público vazio"],
    ["popup nao exibido", "Popup não exibido"],
    ["popup nao aparece", "Popup não exibido"],
    ["conexao de conta indisponivel", "Conexão de conta indisponível"],
    ["conta desconectada", "Conexão de conta indisponível"],
    ["conta de anuncio nao conecta", "Conexão de conta indisponível"],
  ]),
};

export const DEFAULT_ANALYSIS_CATEGORY_CATALOG: Readonly<AnalysisCategoryCatalog> = {
  contactReason: ["Dúvida", "Problema", "Solicitação"],
  productArea: [...new Set(FACET_ALIASES.product?.values() ?? [])],
  platform: [...new Set(FACET_ALIASES.platform?.values() ?? [])],
  symptom: [...new Set(FACET_ALIASES.symptom?.values() ?? [])],
};

function normalizedKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function categorySlug(value: string): string {
  return normalizedKey(value).replace(/\s+/g, "-").slice(0, 80);
}

function isBlockedCategoryKey(key: string): boolean {
  return (
    !key ||
    BLOCKED_EXACT_LABELS.has(key) ||
    INVALID_SOURCE_OR_CHANNEL.test(key) ||
    INVALID_MEDIA_LIMITATION.test(key) ||
    INVALID_REVERSED_MEDIA_LIMITATION.test(key) ||
    INVALID_CONTEXT_LIMITATION.test(key)
  );
}

function canonicalReason(key: string): string | null {
  if (/\b(?:duvida|pergunta|questionamento)\b/u.test(key)) return "Dúvida";
  if (/\b(?:problema|erro|falha|incidente)\b/u.test(key)) return "Problema";
  if (/\b(?:solicitacao|pedido|requisicao)\b/u.test(key)) return "Solicitação";
  return null;
}

export function normalizeCategory(
  facet: CategoryFacet,
  rawLabel: string,
): NormalizedCategory | null {
  const label = normalizedLabel(rawLabel);
  const key = normalizedKey(label);
  if (facet === "reason") {
    const reason = canonicalReason(key);
    if (!reason) return null;
    return { facet, label: reason, slug: categorySlug(reason) };
  }
  if (isBlockedCategoryKey(key)) {
    return null;
  }
  if (INVALID_UNCERTAINTY.test(key)) {
    return null;
  }
  if (facet === "platform" && GENERIC_PLATFORM_LABELS.has(key)) {
    return null;
  }
  if (MEDIA_FORMAT.test(key) && !MEDIA_PROBLEM_SIGNAL.test(key)) {
    return null;
  }

  const catalogLabel = FACET_ALIASES[facet]?.get(key);
  if (STRICT_CATALOG_FACETS.has(facet) && !catalogLabel) {
    return null;
  }
  const canonicalLabel = catalogLabel ?? label;
  const slug = categorySlug(canonicalLabel);
  if (!slug) {
    return null;
  }

  return { facet, label: canonicalLabel, slug };
}

/**
 * Manual catalog entries may extend the installation taxonomy while keeping
 * the same guardrails that reject channels, organisations, media formats and
 * missing-context labels.
 */
export function normalizeCatalogCategory(
  facet: CategoryFacet,
  rawLabel: string,
): NormalizedCategory | null {
  const label = normalizedLabel(rawLabel);
  const key = normalizedKey(label);
  if (isBlockedCategoryKey(key) || INVALID_UNCERTAINTY.test(key)) return null;
  if (facet === "platform" && GENERIC_PLATFORM_LABELS.has(key)) return null;
  if (MEDIA_FORMAT.test(key) && !MEDIA_PROBLEM_SIGNAL.test(key)) return null;

  const canonicalLabel = FACET_ALIASES[facet]?.get(key) ?? label;
  const slug = categorySlug(canonicalLabel);
  if (!slug) return null;
  return { facet, label: canonicalLabel, slug };
}

function catalogForFacet(
  facet: "reason" | "product" | "platform" | "symptom",
  catalog: AnalysisCategoryCatalog,
): string[] {
  switch (facet) {
    case "reason":
      return catalog.contactReason;
    case "product":
      return catalog.productArea;
    case "platform":
      return catalog.platform;
    case "symptom":
      return catalog.symptom;
  }
}

function mergedCatalog(
  catalog?: AnalysisCategoryCatalog,
): AnalysisCategoryCatalog {
  const merge = (defaults: readonly string[], custom: string[] | undefined) =>
    [...new Map(
      [...defaults, ...(custom ?? [])].map((label) => [normalizedKey(label), label]),
    ).values()];
  return {
    contactReason: merge(
      DEFAULT_ANALYSIS_CATEGORY_CATALOG.contactReason,
      catalog?.contactReason,
    ),
    productArea: merge(
      DEFAULT_ANALYSIS_CATEGORY_CATALOG.productArea,
      catalog?.productArea,
    ),
    platform: merge(
      DEFAULT_ANALYSIS_CATEGORY_CATALOG.platform,
      catalog?.platform,
    ),
    symptom: merge(
      DEFAULT_ANALYSIS_CATEGORY_CATALOG.symptom,
      catalog?.symptom,
    ),
  };
}

function normalizeFacetValues(
  facet: "reason" | "product" | "platform" | "symptom",
  values: string[],
  catalog?: AnalysisCategoryCatalog,
): string[] {
  const available = mergedCatalog(catalog);
  const catalogLabels = new Map(
    catalogForFacet(facet, available).map((label) => [normalizedKey(label), label]),
  );
  const normalized = new Map<string, string>();
  for (const rawLabel of values) {
    const builtIn = normalizeCategory(facet, rawLabel);
    const customLabel = catalogLabels.get(normalizedKey(rawLabel));
    const category = builtIn ?? (customLabel
      ? normalizeCatalogCategory(facet, customLabel)
      : null);
    if (category) {
      normalized.set(category.slug, category.label);
    }
  }
  return [...normalized.values()].slice(0, FACET_LIMITS[facet]);
}

export function normalizeAnalysisCategories(
  categories: SupportAnalysis["categories"],
  catalog?: AnalysisCategoryCatalog,
): SupportAnalysis["categories"] {
  return {
    contactReason: normalizeFacetValues("reason", categories.contactReason, catalog),
    productArea: normalizeFacetValues("product", categories.productArea, catalog),
    platform: normalizeFacetValues("platform", categories.platform, catalog),
    symptom: normalizeFacetValues("symptom", categories.symptom, catalog),
  };
}

export function normalizeCategoriesForAnalysis(
  analysis: Pick<SupportAnalysis, "categories" | "createTicket" | "relation">,
  catalog?: AnalysisCategoryCatalog,
): SupportAnalysis["categories"] {
  if (
    !analysis.createTicket ||
    analysis.relation === "social" ||
    analysis.relation === "informational"
  ) {
    return {
      contactReason: [],
      productArea: [],
      platform: [],
      symptom: [],
    };
  }
  return normalizeAnalysisCategories(analysis.categories, catalog);
}
