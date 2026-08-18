import assert from "node:assert/strict";
import test from "node:test";
import { readFrontendFile as readFile } from "./helpers/frontend-source.js";

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Início ${startMarker} não encontrado`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Fim ${endMarker} não encontrado`);
  return source.slice(start, end);
}

test("evidências da investigação quebram linha sem criar overflow horizontal", async () => {
  const message = await readFile(
    new URL("../app/features/tickets/components/investigation-room-message.tsx", import.meta.url),
    "utf8",
  );

  assert.match(message, /className="min-w-0 flex-1"/);
  assert.match(message, /break-words text-xs text-foreground/);
  assert.match(message, /break-all text-xs text-muted-foreground/);
  assert.match(message, /\[overflow-wrap:anywhere\]/);
});

test("ticket mostra resumo após resolução e mantém a sala manual na lateral", async () => {
  const [detail, launcher, resolution] = await Promise.all([
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/investigation-room-launcher.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-resolution-summary.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(detail, /ticket\.resolution \? <TicketResolutionSummary ticket=\{ticket\} \/> : null/);
  assert.ok(detail.indexOf("<TicketResolutionSummary") < detail.indexOf("<TicketNoteComposer"));
  assert.doesNotMatch(detail, /<SuggestionPanel/);
  assert.doesNotMatch(detail, /<InvestigationPanel|Investigação assistida/);
  assert.doesNotMatch(detail, /function InvestigationPanel|function CircleDataIcon/);
  assert.doesNotMatch(detail, /TicketAiGuidance|aria-label="Orientação da IA"/);
  assert.match(detail, /<InvestigationRoomLauncher/);
  assert.match(launcher, /Sala de investigação/);
  assert.match(launcher, /A sala[\s\S]*só é iniciada quando você abrir/);
  assert.match(launcher, /Abrir sala de investigação/);
  assert.match(launcher, /className="mt-4 w-full gap-2"/);
  assert.match(resolution, /aria-label="Resumo do ticket"/);
  assert.match(resolution, /\{ticket\.summary\}/);
  assert.match(resolution, /\{resolution\.summary\}/);
  assert.match(resolution, /whitespace-pre-wrap break-words/);
});

test("ticket resolvido não reapresenta orientação automática antiga", async () => {
  const [detail, format] = await Promise.all([
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/format.ts", import.meta.url), "utf8"),
  ]);
  const suggestionSelection = sourceSection(
    format,
    "export function getSuggestion",
    "export function getSuggestedResponse",
  );
  const responseSelection = sourceSection(
    format,
    "export function getSuggestedResponse",
    "export function formatDuration",
  );

  assert.match(suggestionSelection, /getInvestigationTimestamp/);
  assert.match(suggestionSelection, /validAfter/);
  assert.match(responseSelection, /getInvestigationTimestamp/);
  assert.match(responseSelection, /validAfter/);
  assert.doesNotMatch(detail, /getSuggestedResponse\(ticket\)|TicketAiGuidance/);
  assert.match(detail, /ticket\.resolution \? <TicketResolutionSummary ticket=\{ticket\} \/> : null/);
  assert.doesNotMatch(detail, /Investigação assistida|Investigar novamente/);
  assert.match(detail, /Abrir sala de investigação/);
});

test("mensagens extensas sem espaços quebram dentro da conversa", async () => {
  const conversation = await readFile(
    new URL("../app/features/tickets/components/ticket-conversation.tsx", import.meta.url),
    "utf8",
  );
  assert.match(conversation, /min-w-0/);
  assert.match(conversation, /whitespace-pre-wrap break-words text-sm/);
  assert.match(conversation, /\[overflow-wrap:anywhere\]/);
});

test("contexto isolado preserva a última mensagem e o compositor de notas", async () => {
  const [detail, notes] = await Promise.all([
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-notes.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    detail,
    /<section className="flex h-full min-h-0 w-full min-w-0 flex-col bg-card"/,
  );
  assert.match(detail, /className="min-h-0 min-w-0 flex-1 overflow-y-auto/);
  assert.match(
    notes,
    /<form className="shrink-0 border-t border-border bg-card px-5 py-4"/,
  );
});

test("conversa do ticket reutiliza o padrão visual de bolhas da Inbox", async () => {
  const conversation = await readFile(
    new URL("../app/features/tickets/components/ticket-conversation.tsx", import.meta.url),
    "utf8",
  );

  assert.match(conversation, /message\.sender\.isStaff && "justify-end"/);
  assert.match(conversation, /max-w-\[min\(76%,690px\)\]/);
  assert.match(conversation, /rounded-\[4px_12px_12px_12px\]/);
  assert.match(conversation, /rounded-\[12px_4px_12px_12px\]/);
  assert.match(conversation, /border-primary\/20 bg-primary\/10/);
  assert.doesNotMatch(
    conversation,
    /flex gap-3 px-5 py-3 \$\{fromEmployee \? "bg-primary\/\[0\.035\]"/,
  );
});

test("áudio e transcrição reutilizam o mesmo componente em conversas e tickets", async () => {
  const [inboxMessage, ticketConversation, audioAttachment] = await Promise.all([
    readFile(new URL("../app/features/conversations/components/conversation-message.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/ticket-conversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/shared/audio-attachment.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(inboxMessage, /<AudioAttachment/);
  assert.match(ticketConversation, /<AudioAttachment/);
  assert.match(audioAttachment, /<audio/);
  assert.match(audioAttachment, /whitespace-pre-wrap/);
  assert.match(audioAttachment, /\[overflow-wrap:anywhere\]/);
  assert.match(audioAttachment, /Transcrição para revisão/);
  assert.match(audioAttachment, /Transcrever/);
  assert.match(audioAttachment, /queueAudioTranscription/);
});

test("atalho global abre a busca de tickets sem depender de uma tela de listagem", async () => {
  const [app, header, search] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/layout/page-header.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/shared/support-search-overlay.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(app, /window\.addEventListener\("keydown", handleShortcut\)/);
  assert.match(app, /window\.removeEventListener\("keydown", handleShortcut\)/);
  assert.match(app, /handleSupportSearchShortcut\(event, focusTicketSearch\)/);
  assert.match(app, /setRoomSearchOpen\(true\)/);
  assert.doesNotMatch(app, /searchInputRef=\{ticketSearchRef\}/);
  assert.doesNotMatch(header, /Buscar no suporte|command-search|onOpenSearch/);
  assert.doesNotMatch(app, /onOpenSearch=\{focusTicketSearch\}/);
  assert.match(search, /aria-keyshortcuts="Meta\+K Control\+K"/);
  assert.match(search, /autoFocus/);
});

test("Conversas carregam lotes progressivos de dez itens", async () => {
  const [conversations, conversationDirectory] = await Promise.all([
    readFile(new URL("../app/features/conversations/components/conversations-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/conversations/components/conversation-directory.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(conversations, /const CONVERSATION_PAGE_SIZE = 10/);
  assert.match(conversations, /limit: CONVERSATION_PAGE_SIZE/);
  assert.match(conversations, /Carregar mais conversas/);
  assert.match(
    conversationDirectory,
    /className="flex justify-center px-3 py-3"[\s\S]*Carregar mais conversas/,
  );
  assert.doesNotMatch(conversationDirectory, /className="mx-auto my-3"/);
});

test("Kanban permite criação manual persistida sem mensagem de WhatsApp", async () => {
  const [app, kanban, dialog, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/kanban/components/kanban-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/tickets/components/manual-ticket-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(kanban, /aria-label="Criar ticket manualmente"/);
  assert.match(kanban, /canCreateTicket/);
  assert.match(kanban, /onCreateManualTicket/);
  assert.match(dialog, /Criar ticket sem selecionar mensagens/);
  assert.match(dialog, /Grupo ou conversa relacionada/);
  assert.match(dialog, /Título do ticket/);
  assert.match(dialog, /Resumo do problema ou dúvida/);
  assert.match(dialog, /nada será[\s\S]*enviado ao WhatsApp/);
  assert.match(api, /request<TicketDetail>\("\/api\/tickets"/);
  assert.match(api, /method: "POST"/);
  assert.match(app, /clientRequestId: manualTicketRequestId/);
  assert.match(app, /Ticket #\$\{created\.number\} criado manualmente/);
  assert.match(app, /access\.user\.role !== "viewer"/);
  assert.match(kanban, /variant="default"/);
  assert.match(dialog, /role="alert"/);
  assert.match(dialog, /text-destructive/);
});

test("shell mantém sidebar curta e controles interativos visualmente consistentes", async () => {
  const [app, sidebar, settings, nativeSelect] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/layout/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/native-select.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /h-dvh min-h-0 overflow-hidden/);
  assert.match(app, /ml-\[238px\][\s\S]*max-md:ml-0/);
  assert.match(sidebar, /fixed inset-y-0 left-0/);
  assert.match(sidebar, /w-\[238px\]/);
  assert.match(sidebar, /max-md:-translate-x-full/);
  assert.match(sidebar, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(nativeSelect, /appearance-none/);
  assert.match(nativeSelect, /<ChevronDownIcon/);
  assert.match(nativeSelect, /pointer-events-none absolute/);
  assert.match(settings, /shrink-0 cursor-pointer items-center/);
  assert.match(settings, /grid gap-4 md:grid-cols-3/);
});

test("visão de conversas mantém triagem supervisionada, global e responsiva", async () => {
  const [app, view, dialog, sidebar, api, triage, aiCard, selectionCard, directory] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/conversations/components/conversations-view.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-action-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/components/layout/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/conversations/components/conversation-triage-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-ai-card.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-selection-card.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-directory.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(app, /parseThreadmarkLocation\(initialPath\)/);
  assert.match(
    app,
    /activeView.*useState<ViewId>\(initialNavigation\.view\)/,
  );
  assert.match(app, /getConversations\(\{ attention: "pending", limit: 1 \}\)/);
  assert.match(app, /pendingConversations=\{pendingConversations\}/);
  assert.match(sidebar, /item\.id === "conversations"[\s\S]*?pendingConversations/);
  assert.match(api, /params\.set\("q", options\.query\.trim\(\)\)/);
  assert.match(api, /params\.set\("scope", options\.scope\)/);
  assert.match(api, /params\.set\("attention", options\.attention\)/);
  assert.match(api, /suggestion-settings/);
  assert.match(api, /getTriageAiSettings/);
  assert.match(api, /updateTriageAiSettings/);
  assert.match(api, /\/api\/triage\/settings/);
  assert.match(api, /method:\s*"PUT"/);
  assert.match(api, /\/triage\/analyze/);
  assert.match(api, /triggerConversationAnalysis/);

  assert.match(view, /conversationFilterKeyRef/);
  assert.match(view, /loadedConversationCountRef/);
  assert.match(view, /detailRequestRef\.current !== requestId/);
  assert.match(view, /selectedConversationRef\.current !== conversationId/);
  assert.match(view, /\}, \[refreshOpenConversation, refreshVersion\]\);/);
  assert.doesNotMatch(
    view,
    /\[refreshOpenConversation, refreshVersion, selectedConversationId\]/,
  );
  assert.match(view, /captureConversationViewportAnchor\(scrollContainer\)/);
  assert.match(view, /conversationGenerationRef/);
  assert.match(view, /restoreActiveHistoryViewportAnchor\(\)/);
  assert.doesNotMatch(view, /previousScroll(?:Height|Top)/);
  assert.match(view, /role="log"/);
  assert.match(view, /tabIndex=\{0\}/);
  assert.match(view, /aria-busy=\{detailLoading \|\| loadingEarlier\}/);
  assert.match(view, /pages < 50/);
  assert.match(view, /<ConversationTicketsPanel/);
  assert.doesNotMatch(view, /const linkedTickets = useMemo/);
  assert.match(view, /messageIds: dialogSnapshot\.messageIds/);
  assert.match(view, /setPendingTotal\(response\.pendingTotal\)/);
  assert.match(view, /keepAllPendingMessagesAsContext/);
  assert.match(view, /keepConversationPendingMessagesAsContext/);
  assert.match(api, /\/api\/conversations\/triage\/context-all/);
  assert.match(api, /\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/triage\/context-all/);
  assert.match(directory, /Manter todas como contexto/);
  assert.match(directory, /Manter todas as pendências como contexto/);
  assert.match(directory, /Mensagens, anexos e tickets serão preservados/);
  assert.match(directory, /from "@\/app\/components\/ui\/alert-dialog"/);
  assert.match(triage, /Manter pendências como contexto/);
  assert.match(triage, /somente nesta conversa/);
  assert.match(triage, /onKeepPendingAsContext/);
  assert.doesNotMatch(view, /const normalized = query\.trim/);
  assert.match(view, /block\.suggestedAction === "attach"/);
  assert.match(view, /block\.confidence !== null/);
  assert.match(view, /Ignorar sugestões/);
  assert.match(view, /setConversationSuggestionsMuted/);
  assert.match(view, /getTriageAiSettings/);
  assert.doesNotMatch(view, /updateTriageAiSettings/);
  assert.doesNotMatch(view, /gpt-5\.4-mini|gpt-5\.4.*mais preciso/);
  assert.match(view, /Configuração atual/);
  assert.match(view, /Configurar IA/);
  assert.match(view, /onOpenAiSettings/);
  assert.match(app, /openSettingsTab\("ai"\)/);
  assert.match(view, /suggestionAnalysis:\s*response\.suggestionAnalysis/);
  assert.match(view, /waiting_for_silence/);
  assert.match(view, /waiting_for_audio/);
  assert.match(view, /waiting_for_context/);
  assert.match(view, /Analisar agora/);
  assert.match(view, /triggerConversationAnalysis/);
  assert.match(view, /não cria um\s+ticket/i);
  assert.match(triage, /conversation\.suggestionsMuted/);
  assert.match(triage, /min-w-0/);
  assert.match(triage, /className="w-full whitespace-nowrap"/);
  assert.match(triage, /size="sm"/);
  assert.match(triage, /: "Ignorar sugestões"/);
  assert.doesNotMatch(triage, /Ignorar sugestões \$\{/);
  assert.match(view, /block\.ai\.model/);
  assert.match(view, /block\.ai\?\.fallbackUsed/);
  assert.match(view, /block\.proposedCategories/);
  assert.match(view, /Categorias propostas pela IA/);
  assert.match(selectionCard, /Manter contexto/);
  assert.match(selectionCard, /Restaurar/);
  assert.doesNotMatch(selectionCard, /onIgnore/);
  assert.doesNotMatch(selectionCard, />\s*Ignorar\s*</);
  assert.doesNotMatch(view, /Selecionar todas as pendentes/);
  assert.doesNotMatch(view, /enviar.*WhatsApp/i);

  assert.match(dialog, /Vincular esta conversa à organização/);
  assert.match(dialog, /Esta alteração vinculará toda a conversa/);
  assert.match(dialog, /props\.initialDraft\.clientId === null/);
  assert.match(dialog, />Prioridade</);
  assert.match(dialog, /priorityLabels\.normal/);
  assert.doesNotMatch(dialog, /Loja \/ ecommerce afetado/);
  assert.doesNotMatch(dialog, /affectedStoreId/);
  assert.match(view, /priority:\s*draft\.priority/);
  assert.match(dialog, /from "@\/app\/components\/ui\/dialog"/);
  assert.match(dialog, /<Dialog/);
  assert.match(dialog, /<DialogContent/);
  assert.match(dialog, /onEscapeKeyDown/);
  assert.doesNotMatch(dialog, /event\.key !== "Tab"/);
  assert.match(view, /max-\[760px\]:block max-\[760px\]:overflow-hidden/);
  assert.match(triage, /min-w-0/);
  assert.match(aiCard, /Categorias propostas pela IA/);
  assert.match(aiCard, /flex-wrap/);
  assert.match(
    aiCard,
    /className="h-auto min-h-8 gap-1 px-2 py-1\.5 leading-4 whitespace-normal"[\s\S]*?size="sm"[\s\S]*?: "Revisar"/,
  );
  assert.match(
    aiCard,
    /className="h-auto min-h-8 gap-1 px-2 py-1\.5 leading-4 whitespace-normal"[\s\S]*?size="sm"[\s\S]*?: "Ignorar"/,
  );
  assert.doesNotMatch(aiCard, /Revisar este bloco|Ignorar sugestão|Bloco selecionado/);
});

test("tickets da conversa ficam compactos e abrem histórico paginado em Sheet", async () => {
  const [panel, triage, api, contracts, sheet] = await Promise.all([
    readFile(
      new URL("../app/features/conversations/components/conversation-tickets-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-triage-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ui/sheet.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(panel, /const PREVIEW_LIMIT = 3/);
  assert.match(panel, /const PAGE_LIMIT = 10/);
  assert.match(panel, /statuses: activeStatuses/);
  assert.match(panel, /Histórico concluído/);
  assert.match(panel, /summary\.all === 1/);
  assert.match(panel, /`Ver todos os \$\{ticketCountLabel\(summary\.all\)\}`/);
  assert.match(panel, /displayedTicketsProgressLabel\(items\.length, listTotal\)/);
  assert.match(panel, /Buscar por número ou título/);
  assert.match(panel, /Filtrar tickets por status/);
  assert.match(panel, /Carregar mais tickets/);
  assert.match(panel, /cursor: nextCursor/);
  assert.match(panel, /<Sheet/);
  assert.match(triage, /<ConversationTicketsPanel/);
  assert.match(api, /getConversationTickets/);
  assert.match(api, /\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/tickets/);
  assert.match(contracts, /ConversationTicketListResponse/);
  assert.match(contracts, /nextCursor: string \| null/);
  assert.match(sheet, /data-slot="sheet-content"/);
  assert.match(sheet, /slide-in-from-right/);
});

test("conversa apresenta mensagem citada e reações no alvo sem overflow", async () => {
  const [contracts, view] = await Promise.all([
    readFile(new URL("../shared/contracts.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/conversations/components/conversations-view.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    contracts,
    /replyTo:\s*ConversationReplyReferenceDto\s*\|\s*null/,
  );
  assert.match(contracts, /reactions:\s*ConversationReactionDto\[\]/);
  assert.match(contracts, /reactionUpdates:\s*ConversationReactionUpdateDto\[\]/);
  assert.match(contracts, /providerMessageId:\s*string/);
  assert.match(contracts, /available:\s*boolean/);
  assert.match(contracts, /reactors:\s*Array</);

  assert.match(view, /message\.replyTo/);
  assert.match(view, /message\.reactions\.map/);
  assert.match(view, /applyReactionUpdates/);
  assert.match(view, /response\.reactionUpdates/);
  assert.match(view, /<blockquote/);
  assert.match(view, /Mensagem citada não disponível no histórico/);
  assert.match(view, /aria-label=.*reaç/i);
  assert.match(view, /min-w-0 max-w-full overflow-hidden/);
  assert.match(view, /\[overflow-wrap:anywhere\]/);
  assert.match(view, /flex max-w-full flex-wrap/);
  assert.match(view, /inline-flex min-h-6 min-w-0/);
});

test("imagens aparecem inline nas conversas, tickets e sala de investigação", async () => {
  const [preview, conversations, ticketDetail] = await Promise.all([
    readFile(
      new URL(
        "../app/components/shared/inline-image-attachment.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversations-view.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(preview, /<img/);
  assert.match(preview, /loading="lazy"/);
  assert.match(preview, /decoding="async"/);
  assert.match(preview, /onError=.*setPreviewFailed/);
  assert.match(preview, /attachment\.kind === "image"/);
  assert.match(preview, /mimeType\.toLowerCase\(\)\.startsWith\("image\/"\)/);
  assert.match(preview, /`\$\{API_URL\}\$\{url\}`/);
  assert.match(conversations, /<InlineImageAttachment attachment=\{attachment\}/);
  assert.match(ticketDetail, /<InlineImageAttachment attachment=\{attachment\}/);

  assert.match(preview, /h-auto[\s\S]*?max-w-full[\s\S]*?object-contain/);
  assert.match(preview, /flex w-full max-w-\[460px\] min-w-0/);
});

test("interface remove a investigação automática e preserva apenas a sala manual", async () => {
  const [app, detail, room, api, settings] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/features/tickets/components/investigation-room.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/settings/components/settings-view.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /isInvestigationActive\(current\?\.latestInvestigation \?\? null\)/);
  assert.match(app, /requestTicketSnapshot\(ticketId\)/);
  assert.match(app, /ACTIVE_TICKET_POLL_INTERVAL_MS = 3_000/);
  assert.match(app, /InvestigationRoom|SupportSearchOverlay|openInvestigationThread|addInvestigationThreadMessage/);
  assert.doesNotMatch(app, /getInvestigationJobs|shouldNotifyInvestigationTransition|threadmark:automatic:/);
  assert.doesNotMatch(detail, /InvestigationPanel|Investigação assistida|Investigar novamente|TicketAiGuidance/);
  assert.match(detail, /InvestigationRoomLauncher/);
  assert.match(detail, /Abrir sala de investigação/);
  assert.match(detail, /<TicketResolutionSummary ticket=\{ticket\} \/>/);
  assert.doesNotMatch(room, /AutomaticAnalysisCard|Análise automática anterior/);
  assert.doesNotMatch(api, /investigateTicket|getInvestigationJobs|\/api\/investigations/);
  assert.doesNotMatch(settings, /id:\s*"automatic"/);
});


test("notificações exigem opt-in e a timeline mostra a operação executada", async () => {
  const [app, header, browserNotifications, detail] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/layout/page-header.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/lib/browser-notifications.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(header, /Ativar notificações da sala de investigação/);
  assert.match(header, /onClick=\{onToggleNotifications\}/);
  assert.match(browserNotifications, /Notification\.requestPermission\(\)/);
  assert.match(browserNotifications, /SUPPORT_NOTIFICATION_PREFERENCE_KEY/);
  assert.doesNotMatch(app, /getInvestigationJobs|shouldNotifyInvestigationTransition|threadmark:automatic:/);
  assert.match(app, /previousRoomTurnStateRef/);
  assert.match(app, /threadmark:deep:\$\{latestTurn\.id\}:\$\{latestTurn\.state\}/);
  assert.match(detail, /describeTimelineEvent\(item\)/);
  assert.doesNotMatch(detail, /O ticket recebeu uma atualização interna/);
});

test("ticket preserva notas internas sem recursos de registros personalizados", async () => {
  const [app, detail, directory, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/directory/components/directory-view.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /addTicketInternalNote\(ticketId, body, clientNoteId\)/);
  assert.match(detail, /Adicionar nota interna/);
  assert.match(detail, /nunca é enviada ao WhatsApp/);
  assert.doesNotMatch(detail, /Ecommerce afetado|Cliente não identificado/);
  assert.doesNotMatch(detail, /Registros vinculados|Campos personalizados do Diretório/);
  assert.doesNotMatch(directory, /Registros|Segmentos/);
  assert.doesNotMatch(app, /DirectoryRecord|DirectorySegment|RecordConnector/);
  assert.doesNotMatch(api, /directory-context|directory\/records|record-connectors/);
  assert.match(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/notes/);
  assert.match(api, /method: "PATCH"/);
  assert.match(api, /method: "DELETE"/);
});

test("notas internas podem ser editadas e excluídas após persistência", async () => {
  const [app, detail, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  const updateApi = sourceSection(
    api,
    "export async function updateTicketInternalNote",
    "export async function deleteTicketInternalNote",
  );
  const deleteApi = sourceSection(
    api,
    "export async function deleteTicketInternalNote",
    "export async function upsertTicketProductForwarding",
  );
  assert.match(
    updateApi,
    /\/api\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/notes\/\$\{encodeURIComponent\(noteId\)\}/,
  );
  assert.match(updateApi, /method: "PATCH"/);
  assert.match(updateApi, /body: JSON\.stringify\(input\)/);
  assert.match(
    deleteApi,
    /\/api\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/notes\/\$\{encodeURIComponent\(noteId\)\}/,
  );
  assert.match(deleteApi, /method: "DELETE"/);

  assert.match(detail, /aria-label="Editar nota interna"/);
  assert.match(detail, /title="Editar nota"/);
  assert.match(detail, /aria-label="Excluir nota interna"/);
  assert.match(detail, /title="Excluir nota"/);
  assert.match(detail, /role="alertdialog"/);
  assert.match(detail, /Excluir esta nota\?/);
  assert.match(
    detail,
    /O conteúdo será apagado do SQLite; apenas a ação continuará[\s\S]*?auditada\./,
  );
  assert.match(detail, /Excluindo…" : "Excluir nota"/);
  assert.match(detail, /expectedUpdatedAt: string/);
  assert.match(detail, /onDeleteNote\?:\s*\(noteId: string\)/);
  assert.match(detail, /onUpdateNote\([\s\S]*?ticket\.id,[\s\S]*?expectedUpdatedAt/);
  assert.match(detail, /onDeleteNote\(ticket\.id, noteId\)/);
  assert.match(detail, /confirmDeleteButtonRef/);
  assert.match(detail, /document\.activeElement === cancelButton/);
  assert.match(detail, /returnFocusRef\?\.current\?\.focus/);
  assert.match(detail, /canManageNotes \?/);

  assert.match(detail, /typeof note\.metadata\.updatedAt === "string"/);
  assert.match(detail, /typeof note\.metadata\.updatedBy === "string"/);
  assert.match(detail, /Editada por \{updatedBy \?\? "Operador local"\}/);
  assert.match(detail, /formatFullDate\(updatedAt\)/);

  const updateHandler = sourceSection(
    app,
    "const handleUpdateTicketNote",
    "const handleDeleteTicketNote",
  );
  const updateRequest = updateHandler.indexOf(
    "await updateTicketInternalNote(ticketId, noteId, {",
  );
  assert.match(updateHandler, /body,[\s\S]*?expectedUpdatedAt/);
  assert.match(updateHandler, /error instanceof ApiError && error\.status === 409/);
  const updateInvalidationBefore = updateHandler.indexOf(
    "invalidateTicketSnapshot(ticketId)",
  );
  const updateInvalidationAfter = updateHandler.indexOf(
    "invalidateTicketSnapshot(ticketId)",
    updateRequest,
  );
  const updateCommit = updateHandler.indexOf("commitTicketSnapshot(updated)");
  assert.ok(updateInvalidationBefore >= 0 && updateInvalidationBefore < updateRequest);
  assert.ok(updateRequest >= 0 && updateRequest < updateInvalidationAfter);
  assert.ok(updateInvalidationAfter < updateCommit);
  assert.doesNotMatch(updateHandler, /setTicketDetails|setTickets/);

  const deleteHandler = sourceSection(
    app,
    "const handleDeleteTicketNote",
    "const handleDeleteTicket =",
  );
  const deleteRequest = deleteHandler.indexOf(
    "await deleteTicketInternalNote(ticketId, noteId)",
  );
  const deleteInvalidationBefore = deleteHandler.indexOf(
    "invalidateTicketSnapshot(ticketId)",
  );
  const deleteInvalidationAfter = deleteHandler.indexOf(
    "invalidateTicketSnapshot(ticketId)",
    deleteRequest,
  );
  const deleteCommit = deleteHandler.indexOf("commitTicketSnapshot(updated)");
  assert.ok(deleteInvalidationBefore >= 0 && deleteInvalidationBefore < deleteRequest);
  assert.ok(deleteRequest >= 0 && deleteRequest < deleteInvalidationAfter);
  assert.ok(deleteInvalidationAfter < deleteCommit);
  assert.doesNotMatch(deleteHandler, /setTicketDetails|setTickets/);
});

test("mensagem destacável pode ser desvinculada sem apagar a conversa bruta", async () => {
  const [app, detail, api, contracts] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/contracts.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    contracts,
    /interface TimelineMessageDto[\s\S]*?canDetach\?: boolean/,
  );

  const detachApi = sourceSection(
    api,
    "export async function detachTicketMessage",
    "export async function deleteTicket",
  );
  assert.match(
    detachApi,
    /\/api\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/messages\/\$\{encodeURIComponent\(messageId\)\}/,
  );
  assert.match(detachApi, /method: "DELETE"/);
  assert.match(detachApi, /Promise<TicketDetail>/);

  assert.match(detail, /message\.canDetach && onDetach/);
  assert.match(detail, /aria-label="Desvincular mensagem do ticket"/);
  assert.match(detail, /title="Desvincular do ticket"/);
  assert.match(detail, /role="alertdialog"/);
  assert.match(detail, /Desvincular esta mensagem do ticket\?/);
  assert.match(
    detail,
    /continuará salva em Conversas e no SQLite[\s\S]*?análises futuras/,
  );
  assert.match(detail, /detaching \? "Desvinculando…" : "Desvincular"/);
  assert.match(detail, /cancelDetachButtonRef\.current\?\.focus/);
  assert.match(detail, /document\.activeElement === cancelButton/);
  assert.match(
    detail,
    /canManageNotes[\s\S]*?onDetachMessage\(ticket\.id, messageId\)/,
  );

  const handler = sourceSection(
    app,
    "const handleDetachTicketMessage",
    "const handleDeleteTicket =",
  );
  const requestIndex = handler.indexOf(
    "await detachTicketMessage(ticketId, messageId)",
  );
  const invalidationBefore = handler.indexOf("invalidateTicketSnapshot(ticketId)");
  const invalidationAfter = handler.indexOf(
    "invalidateTicketSnapshot(ticketId)",
    requestIndex,
  );
  const commitIndex = handler.indexOf("commitTicketSnapshot(updated)");
  assert.ok(invalidationBefore >= 0 && invalidationBefore < requestIndex);
  assert.ok(requestIndex >= 0 && requestIndex < invalidationAfter);
  assert.ok(invalidationAfter < commitIndex);
  assert.match(handler, /continua salva em Conversas e no SQLite/);
  assert.doesNotMatch(handler, /setTicketDetails|setTickets/);

  assert.match(detail, /size-6 shrink-0 p-0 text-muted-foreground hover:text-destructive/);
  assert.match(detail, /mt-3 rounded-lg border border-destructive\/25/);
  assert.match(detail, /mt-3 flex justify-end gap-2/);
  assert.match(detail, /variant="destructive"/);
});

test("ticket permite criar, vincular e remover categorias sem sair do atendimento", async () => {
  const detail = await readFile(
    new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detail, /Criar nova categoria/);
  assert.match(detail, /Criar e vincular/);
  assert.match(detail, /Vincular categoria existente/);
  assert.match(detail, /Remover categoria/);
  assert.doesNotMatch(detail, /<div ref=\{categorySectionRef\}>/);
  assert.match(detail, /sectionRef=\{categorySectionRef\}/);
});

test("ticket mantém mensagens e notas visíveis, recolhe eventos e organiza bugs", async () => {
  const [detail, timelineEvents, productPanel] = await Promise.all([
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/lib/timeline-events.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-product-panel.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(detail, /const \[showOperationalEvents, setShowOperationalEvents\] = useState\(false\)/);
  assert.match(detail, /item\.type === "message" \|\| isInternalNoteTimelineEvent\(item\)/);
  assert.match(detail, /Mostrar eventos \(\$\{operationalEventCount\}\)/);
  assert.match(detail, /Ocultar eventos/);
  assert.match(detail, /aria-controls=\{timelineContentId\}/);
  assert.match(detail, /aria-expanded=\{showOperationalEvents\}/);
  assert.match(detail, /formatFullDate\(note\.occurredAt\)/);
  assert.match(timelineEvents, /return event\.eventType === "internal_note_added"/);
  assert.match(timelineEvents, /return !isInternalNoteTimelineEvent\(event\)/);
  assert.match(timelineEvents, /case "ticket_forwarded_to_product"/);
  assert.match(timelineEvents, /case "ticket_product_forwarding_updated"/);

  assert.match(detail, /ticket\.productForwarding/);
  assert.match(detail, /Bug encaminhado/);
  assert.match(detail, /Registrar bug para Produto/);
  assert.match(detail, /Editar bug encaminhado/);
  assert.match(detail, /onOpenProductForwarding\(\)/);
  assert.match(detail, /<ProductForwardingPanel/);
  assert.match(productPanel, /rounded-xl border border-rose-200/);
  assert.match(productPanel, /flex flex-wrap items-center justify-between/);
  assert.match(detail, /image\.addEventListener\("load", handleImageSettled/);
  assert.match(detail, /image\.addEventListener\("error", handleImageSettled/);
  assert.match(detail, /const timelineMediaSignature = useMemo/);
  assert.match(detail, /attachment\.available \? "1" : "0"/);

  assert.match(detail, /rounded-full border border-emerald-200 bg-emerald-50/);
});

test("exclusão permanente de ticket exige confirmação e preserva a conversa bruta", async () => {
  const [app, detail, deletion, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-delete-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /Excluir permanentemente/);
  assert.match(detail, /<TicketDeleteDialog/);
  assert.match(deletion, /const DELETE_CONFIRMATION = "EXCLUIR"/);
  assert.match(deletion, /Esta ação não pode ser desfeita/);
  assert.match(deletion, /A conversa original do WhatsApp permanece/);
  assert.match(deletion, /análises automáticas, sugestões, resolução/);
  assert.match(deletion, /disabled=\{!confirmed \|\| deleting\}/);
  assert.match(app, /await deleteTicket\(ticketId\)/);
  assert.match(app, /ticket\.id !== ticketId/);
  assert.match(app, /A conversa original do WhatsApp foi preservada/);
  assert.match(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(api, /Excluído permanentemente pelo operador/);
  assert.match(deletion, /<Dialog open/);
  assert.match(deletion, /variant="destructive"/);
  assert.match(deletion, /max-\[520px\]:flex-col-reverse/);
  assert.match(deletion, /max-\[520px\]:w-full/);
});

test("resolução permanece vinculada somente ao ticket", async () => {
  const [detail, resolution, resolutionDialog, app] = await Promise.all([
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-resolution-summary.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-resolution-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /<TicketResolutionSummary ticket=\{ticket\} \/>/);
  assert.match(resolution, /Resumo do ticket/);
  assert.match(resolution, /Sobre o atendimento/);
  assert.match(resolution, /Mensagem de resumo/);
  assert.match(resolution, /\{resolution\.summary\}/);
  assert.doesNotMatch(detail, /Resolução validada|resolution-section/);
  assert.match(resolutionDialog, /Como este ticket foi concluído\?/);
  assert.match(resolutionDialog, /exibida integralmente no Resumo do ticket/);
  assert.match(resolutionDialog, /preservada no SQLite/);
  assert.match(resolutionDialog, /Resolver mantendo resumo/);
  assert.match(resolutionDialog, /Resolver e atualizar resumo/);
  assert.match(resolutionDialog, /não criará uma resolução duplicada/);
  assert.match(
    resolutionDialog,
    /field-sizing-fixed min-h-32 min-w-0 max-w-full resize-y overflow-x-hidden whitespace-pre-wrap break-words \[overflow-wrap:anywhere\]/,
  );
  assert.match(resolutionDialog, /wrap="soft"/);
  assert.match(resolutionDialog, /className="flex min-h-0 min-w-0 max-w-full flex-col"/);
  assert.match(app, /<TicketResolutionDialog/);
  assert.match(app, /ticket\.resolution\?\.summary \?\? ""/);
  assert.match(app, /summaryToPersist/);
  assert.match(resolution, /whitespace-pre-wrap break-words/);
});

test("datas completas dos chats exibem o ano", async () => {
  const [conversations, conversationChat, format] = await Promise.all([
    readFile(
      new URL("../app/features/conversations/components/conversations-view.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/conversations/components/conversation-chat.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/format.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    conversations,
    /formatDayDate\(message\.occurredAt\)/,
  );
  assert.match(
    format,
    /formatDayDate[\s\S]*?year:\s*"numeric"/,
  );
  assert.match(conversationChat, /whitespace-nowrap text-muted-foreground/);
});

test("ticket aberto recebe atualizações silenciosas sem sobrepor requisições", async () => {
  const app = await readFile(
    new URL("../app/support-app.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /ACTIVE_TICKET_POLL_INTERVAL_MS = 3_000/);
  assert.match(app, /IDLE_TICKET_POLL_INTERVAL_MS = 5_000/);
  assert.match(app, /MAX_TICKET_POLL_INTERVAL_MS = 30_000/);
  assert.match(app, /activeView !== "inbox" \|\| !currentSelectedId/);
  assert.match(app, /document\.visibilityState !== "visible"/);
  assert.match(app, /addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(app, /removeEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(app, /new TicketSnapshotCoordinator<TicketDetail>\(\)/);
  assert.match(app, /ticketSnapshotCoordinatorRef\.current\.request\(id, getTicket\)/);
  assert.match(app, /ticketSnapshotCoordinatorRef\.current\.invalidate\(id\)/);
  assert.match(app, /ticketListSnapshotCoordinatorRef\.current\.invalidate\(TICKET_LIST_SNAPSHOT_KEY\)/);
  assert.match(app, /requestTicketListSnapshot\(\)\.then/);
  assert.match(app, /invalidateTicketSnapshot\(ticketId\)/);
  assert.match(app, /ticketSnapshotCoordinatorRef\.current\.isCurrent\(ticketId, snapshot\)/);
  assert.match(app, /window\.setTimeout\(\(\) => void pollTicket\(\), interval\)/);
  assert.match(app, /commitTicketSnapshot\(snapshot\.detail\)/);
  assert.match(app, /error instanceof ApiError && error\.status === 404/);
  assert.match(app, /transientFailures = Math\.min\(transientFailures \+ 1, 4\)/);
  assert.match(app, /setSelectedId\(\(current\) => \(current === ticketId \? null : current\)\)/);
  assert.match(app, /if \(hasSameTicketPayload\(existing, detail\)\) return current/);
  assert.match(app, /if \(hasSameTicketPayload\(current\[index\], summary\)\) return current/);
  assert.match(app, /Erros transitórios permanecem silenciosos/);
});

test("ticket oferece edição persistente de título, descrição, prioridade e solicitante", async () => {
  const [app, detail, editor, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/ticket-metadata-editor.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /aria-label="Editar dados do ticket"/);
  assert.match(detail, /<TicketMetadataEditor/);
  assert.match(editor, /Editar dados do ticket/);
  assert.match(editor, />Título</);
  assert.match(editor, />Descrição</);
  assert.match(editor, />Prioridade</);
  assert.match(editor, />Pessoa solicitante</);
  assert.match(editor, /Detectar automaticamente/);
  assert.match(editor, /ticket\.requesterCandidates\.map/);
  assert.match(editor, /Nenhuma[\s\S]*mensagem é enviada ao WhatsApp/);
  assert.match(api, /export async function updateTicketMetadata/);
  assert.match(api, /method: "PATCH"/);
  assert.match(app, /await updateTicketMetadata\(ticketId, input\)/);
  assert.match(app, /Dados do ticket atualizados no SQLite\./);
  assert.match(editor, /<DialogContent/);
  assert.match(editor, /max-h-\[calc\(100dvh-1rem\)\]/);
  assert.match(editor, /w-\[calc\(100%-1rem\)\] max-w-2xl/);
  assert.match(editor, /grid-cols-1 gap-4 sm:grid-cols-3/);
  assert.match(editor, /grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto/);
});

test("encaminhamento de bug persiste no ticket e pode finalizar o atendimento", async () => {
  const [app, detail, forwardingDialog, api] = await Promise.all([
    readFile(new URL("../app/support-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/features/tickets/components/ticket-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/features/tickets/components/product-forwarding-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /setProductForwardingTarget\(\{/);
  assert.match(app, /resolveTicket: !existing && canResolve/);
  assert.match(app, /await upsertTicketProductForwarding/);
  assert.match(app, /commitTicketSnapshot\(updated\)/);
  assert.match(app, /onOpenProductForwarding=\{openProductForwarding\}/);
  assert.match(app, /<ProductForwardingDialog/);
  assert.match(forwardingDialog, /Encaminhar e finalizar atendimento/);
  assert.match(forwardingDialog, /Salvar encaminhamento/);
  assert.match(detail, /Registrar bug para Produto/);
  assert.match(detail, /Bug encaminhado/);
  assert.match(api, /\/api\/tickets\/\$\{encodeURIComponent\(id\)\}\/product-forwarding/);
  assert.match(api, /method: "PUT"/);
  assert.match(api, /export async function getBugTickets/);
  assert.match(api, /productForwardingKind: "bug"/);
  assert.match(api, /includeArchived: "true"/);
  assert.match(api, /const limit = 200/);
  assert.match(api, /offset \+= result\.items\.length/);
  assert.match(api, /offset >= result\.total/);
});
