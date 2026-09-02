"use client";

import { Bot, Database, HardDrive, Laptop, LoaderCircle, Menu, QrCode, RefreshCw, Settings2, ShieldCheck, UserRound, UsersRound, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getAiConnections, getAiTaskProfiles, getInvestigationPacks, getLocalTools, getSettingsUsers, getStaffSettings, getWhatsappQr, getWhatsappRuntime, getWorkspaceSettings, type AiConnection, type AiTaskProfile, type InvestigationPackDto, type SettingsRole, type SettingsUser, type StaffSettings, type WhatsappQrState, type WorkspaceSettings, type LocalToolDto } from "@/app/lib/settings";
import { getTriageAiSettings } from "@/app/lib/api";
import type { RuntimeState } from "@/app/lib/types";
import type { SettingsRouteTab } from "@/app/lib/navigation";
import type { TriageAiSettingsDto } from "@/shared/contracts";
import { ToolsSettingsSection } from "./tools-settings-section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { GeneralSection } from "./sections/general-section";
import { UsersSection } from "./sections/users-section";
import { StaffSection } from "./sections/staff-section";
import { WhatsappSection } from "./sections/whatsapp-section";
import { AiSection } from "./sections/ai-section";
import { DataSection } from "./sections/data-section";
import { SecuritySection } from "./sections/security-section";
import { DesktopSection } from "./sections/desktop-section";
import { getThreadmarkDesktopBridge } from "@/app/lib/desktop";
import {
  EMPTY_STAFF,
  Notice,
  errorMessage,
} from "./settings-support";
export type SettingsTab = SettingsRouteTab;

export interface SettingsViewProps {
  currentUserId: string;
  currentUserRole: SettingsRole;
  initialTab?: SettingsTab;
  onLogout(): Promise<void>;
  onOpenMenu(): void;
  onTabChange?(tab: SettingsTab): void;
  onWorkspaceChange?(workspace: WorkspaceSettings): void;
}

type TabDefinition = {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
};

const TABS: TabDefinition[] = [
  { id: "general", label: "Geral", icon: Settings2 },
  { id: "users", label: "Usuários", icon: UsersRound },
  { id: "staff", label: "Equipe WhatsApp", icon: UserRound },
  { id: "whatsapp", label: "WhatsApp", icon: QrCode },
  { id: "ai", label: "IA", icon: Bot },
  { id: "tools", label: "Ferramentas", icon: Wrench },
  { id: "data", label: "Dados", icon: Database },
  { id: "desktop", label: "Aplicativo", icon: Laptop },
  { id: "security", label: "Segurança", icon: ShieldCheck },
];

const subscribeToDesktopBridge = () => () => undefined;

export function SettingsView({
  currentUserId,
  currentUserRole,
  initialTab = "general",
  onLogout,
  onOpenMenu,
  onTabChange,
  onWorkspaceChange,
}: SettingsViewProps) {
  const [uncontrolledTab, setUncontrolledTab] =
    useState<SettingsTab>(initialTab);
  const activeTab = onTabChange ? initialTab : uncontrolledTab;
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null);
  const [users, setUsers] = useState<SettingsUser[]>([]);
  const [staff, setStaff] = useState<StaffSettings>(EMPTY_STAFF);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [qr, setQr] = useState<WhatsappQrState | null>(null);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [taskProfiles, setTaskProfiles] = useState<AiTaskProfile[]>([]);
  const [triageAiSettings, setTriageAiSettings] =
    useState<TriageAiSettingsDto | null>(null);
  const [tools, setTools] = useState<LocalToolDto[]>([]);
  const [investigationPacks, setInvestigationPacks] = useState<InvestigationPackDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [aiProfilesDirty, setAiProfilesDirty] = useState(false);
  const desktopAvailable = useSyncExternalStore(
    subscribeToDesktopBridge,
    () => Boolean(getThreadmarkDesktopBridge()),
    () => false,
  );

  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const visibleTabs = desktopAvailable
    ? TABS
    : TABS.filter((tab) => tab.id !== "desktop");

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);

      const privilegedRequests = canManage
        ? [
            getSettingsUsers(),
            getStaffSettings(),
            getAiConnections(),
            getAiTaskProfiles(),
            getLocalTools(),
            getInvestigationPacks(),
          ]
        : [
            Promise.resolve([] as SettingsUser[]),
            Promise.resolve(EMPTY_STAFF),
            Promise.resolve([] as AiConnection[]),
            Promise.resolve([] as AiTaskProfile[]),
            Promise.resolve([] as LocalToolDto[]),
            Promise.resolve({ items: [] as InvestigationPackDto[], active: null }),
          ];

      const results = await Promise.allSettled([
        getWorkspaceSettings(),
        getWhatsappRuntime(),
        getTriageAiSettings(),
        ...privilegedRequests,
      ]);

      const [workspaceResult, runtimeResult, triageSettingsResult, usersResult, staffResult, connectionsResult, profilesResult, toolsResult, packsResult] =
        results;
      if (workspaceResult.status === "fulfilled") setWorkspace(workspaceResult.value);
      if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value);
      if (triageSettingsResult.status === "fulfilled") {
        setTriageAiSettings(triageSettingsResult.value);
      }
      if (usersResult.status === "fulfilled") setUsers(usersResult.value as SettingsUser[]);
      if (staffResult.status === "fulfilled") setStaff(staffResult.value as StaffSettings);
      if (connectionsResult.status === "fulfilled") {
        setConnections(connectionsResult.value as AiConnection[]);
      }
      if (profilesResult.status === "fulfilled") {
        setTaskProfiles(profilesResult.value as AiTaskProfile[]);
      }
      if (toolsResult.status === "fulfilled") {
        setTools(toolsResult.value as LocalToolDto[]);
      }
      if (packsResult.status === "fulfilled") {
        setInvestigationPacks(
          (packsResult.value as { items: InvestigationPackDto[] }).items,
        );
      }

      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) setLoadError(errorMessage(failure.reason));
      setLoading(false);
      setRefreshing(false);
    },
    [canManage],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (
      !canManage ||
      activeTab !== "whatsapp" ||
      runtime?.whatsappConnected ||
      !runtime?.qrAvailable
    ) {
      return;
    }
    let cancelled = false;
    void getWhatsappQr()
      .then((nextQr) => {
        if (!cancelled) setQr(nextQr);
      })
      .catch(() => {
        // A conexão pode trocar de estado enquanto a tela é aberta.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, canManage, runtime?.qrAvailable, runtime?.whatsappConnected]);

  useEffect(() => {
    if (!aiProfilesDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [aiProfilesDirty]);

  function selectTab(nextTab: SettingsTab) {
    if (
      activeTab === "ai" &&
      nextTab !== "ai" &&
      aiProfilesDirty &&
      !window.confirm(
        "Existem alterações de IA ainda não salvas. Deseja sair e descartá-las?",
      )
    ) {
      return;
    }
    if (onTabChange) onTabChange(nextTab);
    else setUncontrolledTab(nextTab);
    setFeedback(null);
  }

  function showFeedback(tone: "success" | "error", message: string) {
    setFeedback({ tone, message });
  }

  if (loading && !workspace) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center bg-background p-6">
        <div className="flex items-center gap-3 text-sm font-medium text-muted-foreground" role="status">
          <LoaderCircle className="animate-spin text-primary" size={22} />
          Carregando configurações locais…
        </div>
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      <header className="border-b border-border bg-card px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1180px] flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label="Abrir navegação"
              className="shrink-0 xl:hidden"
              onClick={onOpenMenu}
              size="icon-lg"
              type="button"
              variant="outline"
            >
              <Menu size={17} />
            </Button>
            <div>
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary">
                <Settings2 size={18} />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-foreground">Configurações</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">Workspace, equipe, conexões e dados desta instalação.</p>
              </div>
            </div>
            </div>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">
              <HardDrive size={13} /> Local-first
            </Badge>
            <Button
              aria-label="Atualizar configurações"
              disabled={refreshing}
              onClick={() => void load(true)}
              size="icon-lg"
              type="button"
              variant="outline"
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} />
            </Button>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-3 backdrop-blur sm:px-6 lg:px-8">
        <Tabs
          onValueChange={(value) => selectTab(value as SettingsTab)}
          value={activeTab}
        >
          <TabsList
            aria-label="Seções das configurações"
            className="mx-auto flex h-auto max-w-[1180px] justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger
                  className="inline-flex shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
                  key={tab.id}
                  value={tab.id}
                >
                  <Icon size={15} />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>

      <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {loadError ? (
          <Notice tone="error" title="Algumas configurações não foram carregadas">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button
                onClick={() => void load(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw size={14} /> Tentar novamente
              </Button>
            </div>
          </Notice>
        ) : null}
        {feedback ? (
          <div className="mb-5">
            <Notice
              onClose={() => setFeedback(null)}
              tone={feedback.tone}
              title={feedback.tone === "success" ? "Alterações salvas" : "Não foi possível concluir"}
            >
              {feedback.message}
            </Notice>
          </div>
        ) : null}

        <div role="tabpanel">
          {activeTab === "general" ? (
            <GeneralSection
              canManage={canManage}
              key={`${workspace?.organizationName ?? ""}:${workspace?.workspaceName ?? ""}:${workspace?.timezone ?? ""}`}
              onChange={(nextWorkspace) => {
                setWorkspace(nextWorkspace);
                onWorkspaceChange?.(nextWorkspace);
              }}
              onFeedback={showFeedback}
              workspace={workspace}
            />
          ) : null}
          {activeTab === "users" ? (
            <UsersSection
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              onChange={setUsers}
              onFeedback={showFeedback}
              users={users}
            />
          ) : null}
          {activeTab === "staff" ? (
            <StaffSection
              canManage={canManage}
              key={staff.identities.join("|")}
              onChange={setStaff}
              onFeedback={showFeedback}
              staff={staff}
            />
          ) : null}
          {activeTab === "whatsapp" ? (
            <WhatsappSection
              canManage={canManage}
              onQrChange={setQr}
              onRuntimeChange={setRuntime}
              qr={qr}
              runtime={runtime}
            />
          ) : null}
          {activeTab === "ai" ? (
            <AiSection
              canManage={canManage}
              connections={connections}
              key={triageAiSettings?.updatedAt ?? "triage-settings-loading"}
              onConnectionsChange={setConnections}
              onDirtyChange={setAiProfilesDirty}
              onFeedback={showFeedback}
              onProfilesChange={setTaskProfiles}
              onTriageSettingsChange={setTriageAiSettings}
              profiles={taskProfiles}
              triageSettings={triageAiSettings}
            />
          ) : null}
          {activeTab === "tools" ? (
            <ToolsSettingsSection
              canManage={canManage}
              onChange={setTools}
              onFeedback={showFeedback}
              onPacksChange={setInvestigationPacks}
              packs={investigationPacks}
              tools={tools}
            />
          ) : null}
          {activeTab === "data" ? (
            <DataSection canManage={canManage} onFeedback={showFeedback} />
          ) : null}
          {activeTab === "desktop" ? (
            <DesktopSection canManage={canManage} onFeedback={showFeedback} />
          ) : null}
          {activeTab === "security" ? (
            <SecuritySection
              currentUserRole={currentUserRole}
              onFeedback={showFeedback}
              onLogout={onLogout}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}
