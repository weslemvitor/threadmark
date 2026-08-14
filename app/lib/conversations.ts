import type {
  AttachConversationMessagesInput,
  ConversationBatchActionInput as SharedConversationBatchActionInput,
  ConversationClearPendingResponse,
  ConversationListResponse,
  ConversationMessageDto,
  ConversationMessagesResponse,
  ConversationTicketListResponse,
  ConversationSuggestionAnalysisDto,
  ConversationSuggestionSettingsResponse,
  ConversationSummaryDto,
  ConversationTriageActionResponse,
  ConversationTriageBlocksResponse,
  CreateConversationTicketInput,
  TriageBlockDto,
  TriageKind,
  TriageState,
} from "@/shared/contracts";

export type ConversationSummary = ConversationSummaryDto;
export type ConversationMessage = ConversationMessageDto;
export type ConversationTriageBlock = TriageBlockDto;
export type ConversationTriageKind = TriageKind;
export type ConversationTriageState = TriageState;
export type ConversationActionResponse = ConversationTriageActionResponse;

export type {
  ConversationClearPendingResponse,
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationTicketListResponse,
  ConversationSuggestionSettingsResponse,
  ConversationTriageBlocksResponse,
};

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  blocks: ConversationTriageBlock[];
  suggestionAnalysis: ConversationSuggestionAnalysisDto;
}

export interface ConversationCreateTicketInput
  extends CreateConversationTicketInput {
  conversationId: string;
  title: string;
  summary: string;
  clientId: string | null;
}

export interface ConversationAttachInput
  extends AttachConversationMessagesInput {
  conversationId: string;
}

export interface ConversationBatchActionInput
  extends SharedConversationBatchActionInput {
  conversationId: string;
}
