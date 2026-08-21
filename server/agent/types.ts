export type ParticipantRole = "external" | "staff" | "self" | "unknown";

export interface AnalysisMessage {
  id: string;
  author: string;
  role: ParticipantRole;
  timestampUtc: string;
  text: string | null;
  attachments: Array<{
    id?: string;
    kind: "image" | "document" | "video" | "audio" | "other";
    fileName: string | null;
    mimeType?: string | null;
    /** Local, trusted copy. The runner only attaches images below its media root. */
    localPath?: string | null;
    extractedText: string | null;
  }>;
  quotedMessageId: string | null;
}

export interface DocumentationDraftInput {
  draftId: string;
  ticketId: string;
  ticketNumber: number;
  title: string;
  summary: string;
  resolution: string;
  categories: string[];
  messages: AnalysisMessage[];
  availableImages: Array<{
    attachmentId: string;
    messageId: string;
    fileName: string | null;
    mimeType: string;
  }>;
}

export interface DocumentationDraftResult {
  title: string;
  summary: string;
  audience: string;
  bodyMarkdown: string;
  prerequisites: string[];
  sourceMessageIds: string[];
  imagePlacements: Array<{
    attachmentId: string;
    afterHeading: string | null;
    caption: string;
  }>;
  warnings: string[];
}

export interface SupportConversationState {
  lastExternalMessageAt: string | null;
  lastSentResponseAt: string | null;
  /** External messages received after the latest captured staff response. */
  unansweredExternalMessageIds: string[];
  hasUnansweredExternalMessages: boolean;
}

export interface SupportSentResponse {
  id: string;
  messageId: string | null;
  body: string;
  sentAt: string;
}

export interface SupportResolvedPrecedent {
  ticketId: string;
  title: string;
  summary: string;
  resolvedAt: string | null;
  affectedStore: {
    id: string;
    name: string;
  } | null;
  categories: string[];
  resolution: {
    summary: string;
    rootCause: string | null;
    outcome: string | null;
    validatedAt: string;
  };
  finalResponse: string | null;
}

export interface AnalysisCategoryCatalog {
  contactReason: string[];
  productArea: string[];
  platform: string[];
  symptom: string[];
}

export interface SupportAnalysisInput {
  ticketId?: string;
  operatorInstructions?: string | null;
  accountName: string;
  accountType: "agency" | "ecommerce" | "unknown";
  groupName: string;
  knownEcommerces: string[];
  /** Closed catalog available to the AI for this installation. */
  categoryCatalog?: AnalysisCategoryCatalog;
  /** Explicit temporal state used to distinguish history from unanswered demand. */
  conversationState: SupportConversationState;
  messages: AnalysisMessage[];
  /** Responses already sent by staff. They are facts, never reusable templates. */
  sentResponses: SupportSentResponse[];
  openTickets: Array<{
    id: string;
    title: string;
    summary: string;
    status: string;
  }>;
  /** Resolved cases selected by the backend as secondary semantic precedents. */
  resolvedPrecedents: SupportResolvedPrecedent[];
}

export interface TriageAnalysisInput {
  accountName: string;
  accountType: "agency" | "ecommerce" | "unknown";
  groupName: string;
  knownEcommerces: string[];
  /** Closed catalog available to the AI for this installation. */
  categoryCatalog?: AnalysisCategoryCatalog;
  candidateMessageIds: string[];
  messages: AnalysisMessage[];
  openTickets: Array<{
    id: string;
    title: string;
    summary: string;
    status: string;
  }>;
  pendingSuggestions: Array<{
    id: string;
    title: string;
    summary: string;
    suggestedAction: "create" | "attach" | "ignore";
    suggestedTicketId: string | null;
    lastMessageAt: string;
  }>;
}

export interface TriageCategoryProposal {
  contactReason: string[];
  productArea: string[];
  platform: string[];
  symptom: string[];
}

export interface TriageAnalysisDecision {
  messageIds: string[];
  /**
   * Staff/self messages that belong to this semantic context.
   * They never originate a ticket and remain internal context.
   */
  contextMessageIds?: string[];
  kind: "demand" | "uncertain" | "continuation" | "information" | "social";
  suggestedAction: "create" | "attach" | "ignore" | "wait";
  relatedTicketId: string | null;
  relatedSuggestionId: string | null;
  title: string;
  summary: string;
  affectedEcommerce: string | null;
  categories: TriageCategoryProposal;
  reason: string;
  confidence: number;
}

export interface TriageAnalysis {
  groups: TriageAnalysisDecision[];
}

export type SupportAnalysisOutcome =
  | "reply_ready"
  | "already_answered"
  | "needs_information"
  | "technical_investigation_required";

export interface SupportAnalysis {
  createTicket: boolean;
  outcome: SupportAnalysisOutcome;
  relation:
    | "new"
    | "continuation"
    | "possible_reopen"
    | "informational"
    | "social"
    | "uncertain";
  relatedTicketId: string | null;
  title: string;
  summary: string;
  affectedEcommerce: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  categories: {
    contactReason: string[];
    productArea: string[];
    platform: string[];
    symptom: string[];
  };
  evidence: Array<{
    source: "conversation" | "resolved_ticket";
    summary: string;
    reference: string | null;
  }>;
  suggestedResponse: string | null;
  missingInformation: string[];
  nextAction: string;
  confidence: number;
}

export type InvestigationTurnPhase =
  | "analysis"
  | "needs_information"
  | "conclusion";

export interface InvestigationThreadPromptMessage {
  id: string;
  role: "operator" | "assistant";
  body: string;
  phase: InvestigationTurnPhase | null;
  createdAt: string;
}

export interface InvestigationThreadImage {
  id: string;
  messageId: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  sizeBytes: number;
  /** Trusted local path. Prompt builders must never serialize it. */
  localPath: string;
}

export interface InvestigationToolDescriptor {
  id: string;
  name: string;
  type:
    | "codebase"
    | "knowledge"
    | "debugger_skill"
    | "postgres_readonly"
    | "clickhouse_readonly"
    | "aws_cloudwatch"
    | "vercel"
    | "connected_app";
  description: string | null;
  scope: string;
  operations: Array<{
    name: string;
    description: string;
    argumentsExample: string;
  }>;
}

/** A request emitted by the model. Threadmark validates and executes it outside Codex. */
export interface InvestigationToolRequest {
  requestId: string;
  toolId: string;
  operation: string;
  argumentsJson: string;
  purpose: string;
}

/** Sanitized, bounded output returned to the next model turn as untrusted evidence. */
export interface InvestigationToolResult {
  requestId: string;
  toolId: string;
  toolName: string;
  operation: string;
  argumentsJson: string;
  purpose: string;
  status: "success" | "error";
  summary: string;
  content: string;
  reference: string | null;
  executedAt: string;
}

export interface InvestigationThreadInput {
  threadId: string;
  /** `workspace` powers the global Threadmark AI; legacy ticket rooms use `ticket`. */
  mode?: "ticket" | "workspace";
  currentOperatorMessageId: string;
  durableSummary: string;
  recentMessages: InvestigationThreadPromptMessage[];
  /** Recent operator images, current message first, bounded by the store. */
  images?: InvestigationThreadImage[];
  /** Images must not leave local storage unless the operator explicitly opted in. */
  imageAnalysisApproved?: boolean;
  ticket: SupportAnalysisInput;
  /** Extra ticket contexts explicitly referenced by the operator. */
  relatedTickets?: SupportAnalysisInput[];
  currentContext?: {
    route: string | null;
    label: string | null;
    ticketId: string | null;
    ticketNumber: number | null;
    groupId: string | null;
    groupName: string | null;
  } | null;
  automaticInvestigation: SupportAnalysis | null;
  /** Trusted registry metadata. Secrets and concrete credentials never enter the prompt. */
  availableTools?: InvestigationToolDescriptor[];
  /** Outputs are untrusted evidence even though execution was authorized by Threadmark. */
  toolResults?: InvestigationToolResult[];
  /**
   * Trusted coordinator hook. It is never serialized into a provider prompt and
   * must be awaited immediately after each tool result is produced.
   */
  onToolExecution?: (
    result: InvestigationToolResult,
  ) => void | Promise<void>;
}

export interface InvestigationTurnResult {
  assistantMessage: string;
  phase: InvestigationTurnPhase;
  threadSummary: string;
  evidence: Array<{
    source:
      | "conversation"
      | "knowledge"
      | "resolved_ticket"
      | "database"
      | "clickhouse"
      | "aws"
      | "code"
      | "deployment"
      | "external_app";
    summary: string;
    reference: string | null;
  }>;
  suggestedResponse: string | null;
  nextAction: string | null;
  confidence: number;
  toolRequests: InvestigationToolRequest[];
  /** Added by the trusted coordinator after execution; it is never model-authored. */
  toolExecutions?: InvestigationToolResult[];
}
