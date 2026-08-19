import { apiRequest } from "@/app/lib/api";
import type {
  AutomationDetail,
  AutomationExecution,
  AutomationListResponse,
  AutomationSummary,
  ConnectedAppListResponse,
  ConnectedAppSummary,
  CreateAutomationInput,
  UpdateAutomationInput,
  UpdateAutomationLayoutInput,
  UpdateAutomationMetadataInput,
  UpsertConnectedAppInput,
} from "../domain";
import type { TicketAssigneeDto } from "@/shared/contracts";

const AUTOMATIONS_PATH = "/api/automations";
const CONNECTED_APPS_PATH = "/api/automation-apps";

function idPath(base: string, id: string, suffix = ""): string {
  return `${base}/${encodeURIComponent(id)}${suffix}`;
}

export function listAutomations(): Promise<AutomationListResponse> {
  return apiRequest(AUTOMATIONS_PATH);
}

export function createAutomation(input: CreateAutomationInput): Promise<AutomationDetail> {
  return apiRequest(AUTOMATIONS_PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getAutomation(id: string): Promise<AutomationDetail> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id));
}

export function updateAutomation(
  id: string,
  input: UpdateAutomationInput,
): Promise<AutomationDetail> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id), {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function updateAutomationLayout(
  id: string,
  input: UpdateAutomationLayoutInput,
): Promise<AutomationDetail> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id, "/layout"), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateAutomationMetadata(
  id: string,
  input: UpdateAutomationMetadataInput,
): Promise<AutomationDetail> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id, "/metadata"), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteAutomation(id: string): Promise<{ deleted: true; id: string }> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id), { method: "DELETE" });
}

export function activateAutomation(id: string): Promise<AutomationSummary> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id, "/activate"), { method: "POST" });
}

export function pauseAutomation(id: string): Promise<AutomationSummary> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id, "/pause"), { method: "POST" });
}

export function testAutomation(id: string): Promise<AutomationExecution> {
  return apiRequest(idPath(AUTOMATIONS_PATH, id, "/test"), { method: "POST" });
}

export function decideAutomationExecution(
  id: string,
  input: { approved: boolean; note?: string },
): Promise<AutomationExecution> {
  return apiRequest(idPath("/api/automation-runs", id, "/decision"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function pauseAutomationExecution(id: string): Promise<AutomationExecution> {
  return apiRequest(idPath("/api/automation-runs", id, "/pause"), { method: "POST" });
}

export function resumeAutomationExecution(id: string): Promise<AutomationExecution> {
  return apiRequest(idPath("/api/automation-runs", id, "/resume"), { method: "POST" });
}

export function cancelAutomationExecution(id: string): Promise<AutomationExecution> {
  return apiRequest(idPath("/api/automation-runs", id, "/cancel"), { method: "POST" });
}

export function listConnectedApps(): Promise<ConnectedAppListResponse> {
  return apiRequest(CONNECTED_APPS_PATH);
}

export function listNotificationRecipients(): Promise<TicketAssigneeDto[]> {
  return apiRequest("/api/ticket-assignees");
}

export function createConnectedApp(
  input: UpsertConnectedAppInput,
): Promise<ConnectedAppSummary> {
  return apiRequest(CONNECTED_APPS_PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateConnectedApp(
  id: string,
  input: UpsertConnectedAppInput,
): Promise<ConnectedAppSummary> {
  return apiRequest(idPath(CONNECTED_APPS_PATH, id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function testConnectedApp(id: string): Promise<{ ok: boolean; message: string }> {
  return apiRequest(idPath(CONNECTED_APPS_PATH, id, "/test"), { method: "POST" });
}

export function deleteConnectedApp(id: string): Promise<{ deleted: true; id: string }> {
  return apiRequest(idPath(CONNECTED_APPS_PATH, id), { method: "DELETE" });
}
