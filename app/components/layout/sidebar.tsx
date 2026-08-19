import {
  BarChart3,
  Bell,
  BookOpenText,
  Boxes,
  ChevronLeft,
  CircleGauge,
  LayoutDashboard,
  MessagesSquare,
  PanelLeftClose,
  Settings,
  Tags,
  UsersRound,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";
import type { RuntimeState } from "@/app/lib/types";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import {
  buildThreadmarkPath,
  type ViewId,
} from "@/app/lib/navigation";

export type { ViewId } from "@/app/lib/navigation";

type NavItem = {
  id: ViewId;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
};

const operationItems: NavItem[] = [
  { id: "conversations", label: "Conversas", icon: MessagesSquare },
  { id: "kanban", label: "Kanban", icon: LayoutDashboard },
  { id: "automations", label: "Automações", icon: Workflow },
  { id: "notifications", label: "Notificações", icon: Bell },
];

const organizationItems: NavItem[] = [
  { id: "clients", label: "Diretório", icon: UsersRound },
  { id: "categories", label: "Categorias", icon: Tags },
  { id: "documentation", label: "Documentações", icon: BookOpenText },
];

const insightItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: BarChart3 },
];

const systemItems: NavItem[] = [
  { id: "settings", label: "Configurações", icon: Settings },
];

type SidebarProps = {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  onClose: () => void;
  open: boolean;
  pendingConversations: number;
  reviewTickets: number;
  unreadNotifications: number;
  runtime: RuntimeState | null;
  operatorName: string;
  operatorRole: string;
  workspaceName: string;
};

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const result =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
      : parts[0]?.slice(0, 2) ?? "TM";
  return result.toLocaleUpperCase("pt-BR");
}

function RuntimeBadge({ runtime }: { runtime: RuntimeState | null }) {
  const isOnline = runtime?.whatsappConnected === true;
  const isLocalInvestigation =
    runtime?.state === "offline" && runtime.pid !== null;
  const label = runtime
    ? runtime.state === "syncing"
      ? "Sincronizando"
      : runtime.state === "online"
        ? "Captura ativa"
        : runtime.state === "waiting_qr"
          ? "Aguardando QR Code"
        : runtime.state === "starting"
          ? "Iniciando"
          : runtime.state === "error"
            ? "Requer atenção"
            : isLocalInvestigation
              ? "Investigação local ativa"
              : "Suporte desligado"
    : "Verificando serviço";

  return (
    <div className="flex items-start gap-2.5 px-2 py-2">
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full bg-slate-500 ring-4 ring-slate-500/10",
          isOnline && "bg-emerald-400 ring-emerald-400/10",
          isLocalInvestigation && !isOnline && "bg-violet-400 ring-violet-400/10",
        )}
      />
      <div className="min-w-0">
        <strong className="block text-sm font-semibold text-slate-200">{label}</strong>
        {runtime ? (
          <>
            <span className="mt-1 block text-xs leading-relaxed text-slate-400">
              {runtime.groupsDiscovered} grupos · {runtime.privateConversations} conversas privadas
            </span>
            {runtime.groupsDiscovered > 0 ? (
              <span className={cn("mt-0.5 block text-xs text-slate-400", runtime.monitoredGroups === 0 && "text-amber-400")}>
                {runtime.monitoredGroups === 0
                  ? "Nenhum grupo monitorado · tickets pausados"
                  : `${runtime.monitoredGroups} grupos monitorados`}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mt-1 block text-xs text-slate-400">API local · porta 4317</span>
        )}
      </div>
    </div>
  );
}

function NavGroup({
  title,
  items,
  activeView,
  onNavigate,
  pendingConversations,
  reviewTickets,
  unreadNotifications,
}: {
  title: string;
  items: NavItem[];
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  pendingConversations: number;
  reviewTickets: number;
  unreadNotifications: number;
}) {
  return (
    <div className="mb-5">
      <p className="mb-1 px-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
      <nav aria-label={title} className="grid gap-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          const count =
            item.id === "conversations"
              ? pendingConversations
              : item.id === "kanban"
                ? reviewTickets
                : item.id === "notifications"
                  ? unreadNotifications
                : null;
          return (
            <Button
              asChild
              className={cn(
                "h-9 w-full justify-start gap-2.5 rounded-lg px-3 text-sm font-medium text-slate-400 hover:bg-card/5 hover:text-slate-100",
                activeView === item.id && "bg-primary/25 text-white hover:bg-primary/30 hover:text-white",
              )}
              key={item.id}
              variant="ghost"
            >
              <a
                href={buildThreadmarkPath({ view: item.id })}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onNavigate(item.id);
                }}
              >
                <Icon size={18} strokeWidth={1.9} />
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                {count !== null && count > 0 ? (
                  <small className="grid min-w-5 place-items-center rounded-full bg-card/10 px-1.5 py-0.5 text-xs text-slate-200">{count}</small>
                ) : null}
              </a>
            </Button>
          );
        })}
      </nav>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const presentationMode = props.runtime?.connectedAccount
    ?.toLocaleLowerCase("pt-BR")
    .includes("apresentação") === true;

  return (
    <>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[238px] -translate-x-full flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200 md:translate-x-0",
          props.open && "translate-x-0",
        )}
      >
        <div className="flex h-[72px] shrink-0 items-center gap-3 border-b border-white/5 px-4">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-sm" aria-hidden="true">
            <Boxes size={21} strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <strong className="block text-sm font-semibold text-white">Threadmark</strong>
            <span className="mt-0.5 block text-xs text-slate-400">Suporte local</span>
          </div>
          <Button
            aria-label="Fechar navegação"
            className="inline-flex text-slate-400 hover:bg-card/10 hover:text-white md:hidden"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <PanelLeftClose size={18} />
          </Button>
        </div>

        <div className="mx-3 mt-3 flex items-center gap-2.5 rounded-xl border border-white/10 bg-card/5 p-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/25 text-xs font-bold text-violet-200">{initials(props.workspaceName)}</div>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-sm font-semibold text-slate-100">{props.workspaceName}</strong>
            <span className="mt-0.5 block truncate text-xs text-slate-400">{presentationMode ? "Ambiente de apresentação" : "Somente nesta máquina"}</span>
          </div>
          <ChevronLeft className="-rotate-90 text-slate-500" size={15} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
          <NavGroup
            title="Operação"
            items={operationItems}
            activeView={props.activeView}
            onNavigate={props.onNavigate}
            pendingConversations={props.pendingConversations}
            reviewTickets={props.reviewTickets}
            unreadNotifications={props.unreadNotifications}
          />
          <NavGroup
            title="Organização"
            items={organizationItems}
            activeView={props.activeView}
            onNavigate={props.onNavigate}
            pendingConversations={props.pendingConversations}
            reviewTickets={props.reviewTickets}
            unreadNotifications={props.unreadNotifications}
          />
          <NavGroup
            title="Insights"
            items={insightItems}
            activeView={props.activeView}
            onNavigate={props.onNavigate}
            pendingConversations={props.pendingConversations}
            reviewTickets={props.reviewTickets}
            unreadNotifications={props.unreadNotifications}
          />
          <NavGroup
            title="Sistema"
            items={systemItems}
            activeView={props.activeView}
            onNavigate={props.onNavigate}
            pendingConversations={props.pendingConversations}
            reviewTickets={props.reviewTickets}
            unreadNotifications={props.unreadNotifications}
          />
        </div>

        <div className="shrink-0 border-t border-white/5 px-3 py-3">
          <RuntimeBadge runtime={props.runtime} />
          <Button
            aria-label="Abrir configurações da conta"
            className="mt-1 h-auto w-full justify-start gap-2.5 rounded-xl border border-white/10 bg-card/5 px-2.5 py-2 text-left text-slate-200 hover:bg-card/10 hover:text-white"
            onClick={() => props.onNavigate("settings")}
            type="button"
            variant="ghost"
          >
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/20 text-xs font-bold text-violet-200">{initials(props.operatorName)}</div>
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-xs font-semibold">{props.operatorName}</strong>
              <span className="mt-0.5 block truncate text-2xs text-slate-400">{props.operatorRole}</span>
            </div>
            <CircleGauge size={17} />
          </Button>
        </div>
      </aside>
      {props.open ? (
        <Button
          aria-label="Fechar navegação"
          className="fixed inset-0 z-40 block h-auto w-auto rounded-none bg-black/45 p-0 md:hidden"
          onClick={props.onClose}
          type="button"
          variant="ghost"
        />
      ) : null}
    </>
  );
}
