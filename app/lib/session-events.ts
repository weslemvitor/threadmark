const SESSION_EXPIRED_EVENT = "threadmark:session-expired";

export function notifySessionExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export function subscribeSessionExpired(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(SESSION_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
}
