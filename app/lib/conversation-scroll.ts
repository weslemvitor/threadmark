export type ConversationScrollMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

export type ConversationRequestIdentity = {
  conversationId: string | null;
  generation: number;
};

export const CONVERSATION_BOTTOM_THRESHOLD_PX = 120;

export function conversationDistanceFromBottom(
  metrics: ConversationScrollMetrics,
): number {
  return Math.max(
    0,
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
  );
}

export function isNearConversationBottom(
  metrics: ConversationScrollMetrics,
  threshold = CONVERSATION_BOTTOM_THRESHOLD_PX,
): boolean {
  return conversationDistanceFromBottom(metrics) <= Math.max(0, threshold);
}

export function isCurrentConversationRequest(
  request: ConversationRequestIdentity,
  current: ConversationRequestIdentity,
): boolean {
  return (
    request.conversationId !== null &&
    request.conversationId === current.conversationId &&
    request.generation === current.generation
  );
}

export function scrollTopForPreservedAnchor(input: {
  currentScrollTop: number;
  currentViewportOffset: number;
  preservedViewportOffset: number;
}): number {
  return Math.max(
    0,
    input.currentScrollTop +
      input.currentViewportOffset -
      input.preservedViewportOffset,
  );
}
