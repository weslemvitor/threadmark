const BLOCKING_CONFIRMATION_PATTERN =
  /\b(?:nao|nunca|cancela|cancelar|pare|parar|aguarde|aguardar|espera|esperar|antes|mas|porem|talvez|depende|se|so depois|na verdade|quero mudar|precisa mudar|preciso mudar)\b/;

const DIRECT_CONFIRMATION_PATTERN =
  /^(?:(?:eu\s+)?(?:confirmo|autorizo|aprovo)|(?:esta\s+)?(?:confirmado|autorizado|aprovado)|sim|ok|okay|beleza|fechado|certo|combinado|show|bora|vamos|pode)(?:\s+(?:sim|isso|agora|entao|ai|la|por favor|pf|pls))*$/;

const ACTION_CONFIRMATION_PREFIX_PATTERN =
  /^(?:(?:(?:sim|beleza|ok|okay|fechado|certo)\s+)(?:pode\s+)?(?:criar|crie|fazer|faca|seguir|prossiga|prosseguir|executar|execute|aplicar|aplique|atualizar|atualize|alterar|altere|salvar|salve|publicar|publique|vincular|vincule|anexar|anexe|mandar|mande)|pode\s+(?:criar|crie|fazer|faca|seguir|prossiga|prosseguir|executar|execute|aplicar|aplique|atualizar|atualize|alterar|altere|salvar|salve|publicar|publique|vincular|vincule|anexar|anexe|mandar|mande)|(?:crie|faca|siga|prossiga|execute|aplique|atualize|altere|salve|publique|mande))\b/;

const COLLOQUIAL_CONFIRMATION_PATTERN =
  /^(?:manda\s+(?:bala|ver)|toca\s+(?:ficha|o barco)|vai\s+em\s+frente|segue|pode\s+d(?:a|ar)(?:le|lhe|ler)?|dale|daler)(?:\s+(?:agora|entao|ai|la|por favor|pf|pls))*$/;

const RETRY_INSTRUCTION_PATTERN =
  /^(?:tenta|tente|tentar)(?:\s+(?:de\s+novo|novamente|outra\s+vez))?(?:\s+(?:isso|agora|ai|por\s+favor|pf|pls))*$/;

/**
 * Reconhece uma resposta curta que autoriza a ultima previa apresentada.
 * A funcao e deliberadamente restrita: pedidos condicionais, correcoes e
 * negacoes devem voltar para o agente em vez de executar uma mutacao.
 */
export function isAffirmativePreviewConfirmation(message: string): boolean {
  const normalized = normalizeConfirmation(message);
  if (!normalized || normalized.length > 160) return false;
  if (BLOCKING_CONFIRMATION_PATTERN.test(normalized)) return false;

  if (/^(?:eu\s+)?(?:confirmo|autorizo|aprovo)\b/.test(normalized)) return true;
  if (ACTION_CONFIRMATION_PREFIX_PATTERN.test(normalized)) return true;
  return [
    DIRECT_CONFIRMATION_PATTERN,
    COLLOQUIAL_CONFIRMATION_PATTERN,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * Reconhece somente uma ordem curta para repetir a tarefa anterior. Isso não é
 * uma autorização autônoma: cada ferramenta de escrita deve comprovar que há
 * uma instrução explícita anterior ou uma prévia pendente na mesma conversa.
 */
export function isRetryInstruction(message: string): boolean {
  const normalized = normalizeConfirmation(message);
  return Boolean(normalized && normalized.length <= 160 && RETRY_INSTRUCTION_PATTERN.test(normalized));
}

const CONTINUE_INSTRUCTION_PATTERN =
  /^(?:continue|continuar|continua|prossiga|prosseguir|segue|siga|vai\s+em\s+frente|pode\s+seguir|faca\s+isso|faz\s+isso|execute\s+isso)(?:\s+(?:agora|entao|ai|por\s+favor|pf|pls))*$/;

/** A short directive that keeps the unfinished task instead of starting another one. */
export function isTaskContinuationInstruction(message: string): boolean {
  const normalized = normalizeConfirmation(message);
  if (!normalized || normalized.length > 160) return false;
  return isRetryInstruction(message) ||
    DIRECT_CONFIRMATION_PATTERN.test(normalized) ||
    COLLOQUIAL_CONFIRMATION_PATTERN.test(normalized) ||
    CONTINUE_INSTRUCTION_PATTERN.test(normalized);
}

export function normalizeConfirmation(message: string): string {
  return message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
