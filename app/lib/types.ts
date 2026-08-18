import type {
  AttachmentDto,
  CategoryDto,
  CategoryCatalogDto,
  CategoryFacet,
  ClientSummaryDto,
  DashboardResponse,
  DirectoryFieldDefinitionDto,
  DirectoryFieldDefinitionInput,
  DirectoryRecordDto,
  DirectoryRecordInput,
  DirectoryRecordTypeDto,
  DirectoryRecordTypeInput,
  DirectorySegmentDto,
  DirectorySegmentInput,
  DirectorySnapshotDto,
  InvestigationThreadDto,
  InvestigationThreadMessageDto,
  InvestigationThreadSummaryDto,
  InvestigationThreadTurnDto,
  RuntimeStatusDto,
  SuggestionDto,
  TicketDetailDto,
  TicketAssigneeDto,
  TicketPriority,
  TicketStatus,
  TicketSummaryDto,
  TimelineEventDto,
  TimelineItemDto,
  TimelineMessageDto,
  UpdateClientProfileInput,
  UpdateTicketContextInput,
  UpdateTicketMetadataInput,
  UpdateTicketAssigneeInput,
} from "../../shared/contracts.js";

export type {
  AttachmentDto,
  CategoryDto,
  ClientSummaryDto,
  DashboardResponse,
  DirectoryFieldDefinitionDto,
  DirectoryFieldDefinitionInput,
  DirectoryRecordDto,
  DirectoryRecordInput,
  DirectoryRecordTypeDto,
  DirectoryRecordTypeInput,
  DirectorySegmentDto,
  DirectorySegmentInput,
  DirectorySnapshotDto,
  InvestigationThreadDto,
  InvestigationThreadMessageDto,
  InvestigationThreadSummaryDto,
  InvestigationThreadTurnDto,
  RuntimeStatusDto,
  SuggestionDto,
  CategoryCatalogDto,
  TicketDetailDto,
  TicketAssigneeDto,
  TicketPriority,
  TicketStatus,
  TicketSummaryDto,
  TimelineEventDto,
  TimelineItemDto,
  TimelineMessageDto,
  UpdateClientProfileInput,
  UpdateTicketContextInput,
  UpdateTicketMetadataInput,
  UpdateTicketAssigneeInput,
};

export type RuntimeState = RuntimeStatusDto;
export type ClientSummary = ClientSummaryDto;
export type DirectorySnapshot = DirectorySnapshotDto;
export type DirectoryRecordType = DirectoryRecordTypeDto;
export type DirectoryFieldDefinition = DirectoryFieldDefinitionDto;
export type DirectoryRecord = DirectoryRecordDto;
export type DirectorySegment = DirectorySegmentDto;
export type DashboardData = DashboardResponse;
export type TicketSummary = TicketSummaryDto;
export type TicketDetail = TicketDetailDto;
export type TicketAssignee = TicketAssigneeDto;
export type TicketCategory = CategoryDto;
export type TicketCategoryCatalog = CategoryCatalogDto;
export type CategoryFacetType = CategoryFacet;
export type Attachment = AttachmentDto;
export type AnswerSuggestion = SuggestionDto;
