import type {
  DashboardResponse,
  InvestigationJobListResponse,
  InvestigateTicketResponse,
  OperationalGroupDto,
  RuntimeStatusDto,
  TicketDetailDto,
  TicketListResponse,
} from "../shared/contracts.js";

import type { OperationsSnapshot } from "./model.js";

export class TuiApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TuiApiError";
  }
}

export class SupportTuiApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly localAccessToken?: string,
  ) {}

  async getOperationsSnapshot(): Promise<OperationsSnapshot> {
    const [runtime, dashboard, tickets, groups, investigations] =
      await Promise.all([
        this.request<RuntimeStatusDto>("/api/runtime"),
        this.request<DashboardResponse>("/api/dashboard"),
        this.request<TicketListResponse>("/api/tickets?limit=200"),
        this.request<OperationalGroupDto[]>("/api/groups"),
        this.request<InvestigationJobListResponse>(
          "/api/investigations?limit=100",
        ),
      ]);

    return {
      runtime,
      dashboard,
      tickets: tickets.items,
      groups,
      investigations,
      refreshedAt: new Date().toISOString(),
      apiOnline: true,
      error: null,
    };
  }

  getTicket(ticketId: string): Promise<TicketDetailDto> {
    return this.request<TicketDetailDto>(
      `/api/tickets/${encodeURIComponent(ticketId)}`,
    );
  }

  queueInvestigation(ticketId: string): Promise<InvestigateTicketResponse> {
    return this.request<InvestigateTicketResponse>(
      `/api/tickets/${encodeURIComponent(ticketId)}/investigate`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(this.localAccessToken
            ? { Authorization: `Bearer ${this.localAccessToken}` }
            : {}),
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      throw new TuiApiError(
        "API local indisponível. Ligue o suporte com npm run support:on.",
      );
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string | { message?: string };
        message?: string;
      } | null;
      const message =
        payload?.message ??
        (typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message) ??
        `A API respondeu com ${response.status}.`;
      throw new TuiApiError(message, response.status);
    }

    return (await response.json()) as T;
  }
}
