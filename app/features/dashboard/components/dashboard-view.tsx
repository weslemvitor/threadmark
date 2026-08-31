import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ChartPie,
  CheckCircle2,
  Clock3,
  Download,
  Gauge,
  Inbox,
  LoaderCircle,
  MessageSquareWarning,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TimerReset,
  TrendingUp,
  UserMinus,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getDashboard, getDashboardExport } from "@/app/lib/api";
import {
  dashboardDateRangeError,
  dashboardPeriodOptions,
  dashboardRangeKey,
  formatDashboardRangeLabel,
  getDashboardPresetRange,
  type DashboardDateRange,
  type DashboardPeriodId,
} from "@/app/lib/dashboard-period";
import {
  formatNumber,
  getClientName,
  priorityLabels,
  statusLabels,
} from "@/app/lib/format";
import type { DashboardData, TicketSummary } from "@/app/lib/types";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";
import { cn } from "@/app/lib/utils";
import {
  DashboardDailyChart,
  DashboardHorizontalBars,
  DashboardMetricCard,
  DashboardStatusDonut,
} from "./dashboard-charts";

const allAssigneesFilter = "all";
const unassignedFilter = "unassigned";

function dashboardRequestKey(
  range: DashboardDateRange,
  assigneeId: string,
): string {
  return `${dashboardRangeKey(range)}:${assigneeId}`;
}

type MetricComparison = {
  current: number | null;
  previous: number | null;
};

function comparisonPresentation(
  metric: MetricComparison | undefined,
  favorableDirection?: "higher" | "lower",
): { label: string; tone: "positive" | "negative" | "neutral" } | null {
  if (!metric || metric.current === null || metric.previous === null) return null;
  const delta = metric.current - metric.previous;
  if (delta === 0) return { label: "Sem variação", tone: "neutral" };
  if (metric.previous === 0) {
    return { label: "Novo vs. anterior", tone: "neutral" };
  }
  const percentage = Math.abs((delta / metric.previous) * 100);
  const direction = delta > 0 ? "↑" : "↓";
  const favorable = favorableDirection === "higher"
    ? delta > 0
    : favorableDirection === "lower"
      ? delta < 0
      : null;
  return {
    label: `${direction} ${percentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% vs. anterior`,
    tone: favorable === null ? "neutral" : favorable ? "positive" : "negative",
  };
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${formatNumber(Math.round(minutes))} min`;
  if (minutes < 1_440) {
    return `${(minutes / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
  }
  return `${(minutes / 1_440).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}

function DashboardPanelHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex min-h-9 items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {action}
    </header>
  );
}

export function DashboardView({
  dashboard,
  loading,
  onOpenInbox,
  onOpenTicket,
  timeZone,
}: {
  dashboard: DashboardData | null;
  loading: boolean;
  onOpenInbox: () => void;
  onOpenTicket: (id: string) => void;
  timeZone: string;
}) {
  const initialRange = useMemo(
    () => getDashboardPresetRange("last_7_days", new Date(), timeZone),
    [timeZone],
  );
  const [selectedPeriod, setSelectedPeriod] =
    useState<DashboardPeriodId>("last_7_days");
  const [selectedAssignee, setSelectedAssignee] = useState(allAssigneesFilter);
  const [range, setRange] = useState<DashboardDateRange>(initialRange);
  const [draftFrom, setDraftFrom] = useState(initialRange.from ?? "");
  const [draftTo, setDraftTo] = useState(initialRange.to ?? "");
  const [customError, setCustomError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [filterLoading, setFilterLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadedDashboard, setLoadedDashboard] = useState<{
    requestKey: string;
    data: DashboardData;
  } | null>(null);
  const rangeFrom = range.from;
  const rangeTo = range.to;
  const activeRangeKey = dashboardRangeKey(range);
  const activeRequestKey = dashboardRequestKey(range, selectedAssignee);
  const today = initialRange.to ?? "";

  useEffect(() => {
    let active = true;
    const requestedRange = { from: rangeFrom, to: rangeTo };
    const requestedKey = dashboardRequestKey(requestedRange, selectedAssignee);
    void getDashboard(requestedRange, selectedAssignee)
      .then((data) => {
        if (active) setLoadedDashboard({ requestKey: requestedKey, data });
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar os indicadores deste período.",
        );
      })
      .finally(() => {
        if (active) setFilterLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dashboard, rangeFrom, rangeTo, reloadVersion, selectedAssignee]);

  const currentDashboard =
    loadedDashboard?.requestKey === activeRequestKey
      ? loadedDashboard.data
      : activeRangeKey === "all:all" && selectedAssignee === allAssigneesFilter
        ? dashboard
        : null;
  const effectiveRange = currentDashboard?.period
    ? { from: currentDashboard.period.from, to: currentDashboard.period.to }
    : range;
  const rangeLabel = formatDashboardRangeLabel(effectiveRange, timeZone);
  const assigneeOptions =
    currentDashboard?.assigneeMetrics ??
    loadedDashboard?.data.assigneeMetrics ??
    dashboard?.assigneeMetrics ??
    [];
  const selectedAssigneeLabel =
    selectedAssignee === allAssigneesFilter
      ? "Toda a equipe"
      : selectedAssignee === unassignedFilter
        ? "Sem responsável"
        : assigneeOptions.find((metric) => metric.assignee?.id === selectedAssignee)
            ?.assignee?.displayName ?? "Responsável selecionado";

  function loadRange(nextRange: DashboardDateRange) {
    setFilterLoading(true);
    setLoadError(null);
    if (dashboardRangeKey(nextRange) === activeRangeKey) {
      setReloadVersion((current) => current + 1);
      return;
    }
    setRange(nextRange);
  }

  function retryDashboard() {
    setFilterLoading(true);
    setLoadError(null);
    setReloadVersion((current) => current + 1);
  }

  function selectAssignee(assigneeId: string) {
    if (assigneeId === selectedAssignee) return;
    setFilterLoading(true);
    setLoadError(null);
    setExportError(null);
    setSelectedAssignee(assigneeId);
  }

  function selectPeriod(period: DashboardPeriodId) {
    setSelectedPeriod(period);
    setCustomError(null);
    setExportError(null);
    if (period === "custom") {
      const fallback = getDashboardPresetRange("last_7_days", new Date(), timeZone);
      setDraftFrom(range.from ?? fallback.from ?? "");
      setDraftTo(range.to ?? fallback.to ?? "");
      return;
    }
    const nextRange = getDashboardPresetRange(period, new Date(), timeZone);
    setDraftFrom(nextRange.from ?? "");
    setDraftTo(nextRange.to ?? "");
    loadRange(nextRange);
  }

  function applyCustomRange() {
    const error = dashboardDateRangeError(draftFrom, draftTo);
    setCustomError(error);
    if (error) return;
    const nextRange = { from: draftFrom, to: draftTo };
    loadRange(nextRange);
  }

  async function exportDashboard() {
    if (!currentDashboard || exporting) return;
    setExporting(true);
    setExported(false);
    setExportError(null);
    try {
      const result = await getDashboardExport(range, selectedAssignee);
      const objectUrl = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = result.fileName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setExported(true);
      window.setTimeout(() => setExported(false), 1_800);
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : "Não foi possível exportar este período.",
      );
    } finally {
      setExporting(false);
    }
  }

  const toolbar = (
    <Card
      aria-label="Filtrar indicadores por período e responsável"
      className="mb-4 grid gap-3 p-3 py-3 shadow-sm lg:grid-cols-[minmax(210px,1fr)_auto]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <CalendarDays size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <strong className="text-sm font-semibold text-foreground">Período dos indicadores</strong>
          <small className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Tickets criados e resoluções de {rangeLabel} · {selectedAssigneeLabel}</small>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-2 lg:justify-end">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Período</span>
          <Select
            onValueChange={(value) => selectPeriod(value as DashboardPeriodId)}
            value={selectedPeriod}
          >
            <SelectTrigger aria-label="Selecionar período do dashboard" className="h-9 w-full min-w-40 text-sm sm:w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dashboardPeriodOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Responsável</span>
          <Select
            onValueChange={selectAssignee}
            value={selectedAssignee}
          >
            <SelectTrigger aria-label="Filtrar dashboard por responsável" className="h-9 w-full min-w-44 text-sm sm:w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allAssigneesFilter}>Toda a equipe</SelectItem>
              {assigneeOptions
                .filter((metric) => metric.assignee)
                .map((metric) => (
                  <SelectItem key={metric.assignee!.id} value={metric.assignee!.id}>
                    {metric.assignee!.displayName}
                    {metric.assignee!.active ? "" : " (inativo)"}
                  </SelectItem>
                ))}
              {assigneeOptions.some((metric) => !metric.assignee) ? (
                <SelectItem value={unassignedFilter}>Sem responsável</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </label>
        {selectedPeriod === "custom" ? (
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">De</span>
              <Input
                className="h-9 w-36 text-sm"
                max={draftTo || today}
                onChange={(event) => {
                  setDraftFrom(event.target.value);
                  setCustomError(null);
                }}
                type="date"
                value={draftFrom}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Até</span>
              <Input
                className="h-9 w-36 text-sm"
                max={today}
                min={draftFrom || undefined}
                onChange={(event) => {
                  setDraftTo(event.target.value);
                  setCustomError(null);
                }}
                type="date"
                value={draftTo}
              />
            </label>
            <Button onClick={applyCustomRange} size="lg" type="button" variant="outline">
              Aplicar
            </Button>
          </div>
        ) : null}
        <Button
          aria-label={`Exportar dashboard de ${rangeLabel} em CSV`}
          disabled={!currentDashboard || filterLoading || exporting}
          onClick={() => void exportDashboard()}
          size="lg"
          type="button"
          variant="default"
        >
          {exporting ? <LoaderCircle className="animate-spin" size={15} /> : <Download size={15} />}
          {exporting ? "Exportando…" : exported ? "Exportado" : "Exportar CSV"}
        </Button>
      </div>
      <div aria-live="polite" className="flex min-h-4 min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground empty:hidden lg:col-span-2">
        {filterLoading ? <span className="inline-flex min-w-0 items-center gap-1"><LoaderCircle className="animate-spin" size={12} /> Atualizando período…</span> : null}
        {customError ? <span className="text-destructive" role="alert">{customError}</span> : null}
        {exportError ? <span className="text-destructive" role="alert">{exportError}</span> : null}
      </div>
    </Card>
  );

  if (!currentDashboard) {
    return (
      <div className="min-h-full w-full p-4 sm:p-5">
        {toolbar}
        {loading || filterLoading ? (
          <LoadingState label="Calculando indicadores do período…" />
        ) : (
          <div className="grid place-items-center">
            <EmptyState
              title="Dashboard indisponível"
              description={loadError ?? "Ligue o serviço local para consultar as métricas do atendimento."}
            />
            <Button className="-mt-3" onClick={retryDashboard} type="button" variant="outline">
              <RefreshCw size={14} /> Tentar novamente
            </Button>
          </div>
        )}
      </div>
    );
  }

  const statusColors = {
    new: "var(--chart-1)",
    triage: "var(--chart-5)",
    in_progress: "var(--chart-2)",
    waiting_customer: "var(--chart-3)",
    blocked: "var(--destructive)",
    resolved: "var(--chart-4)",
    cancelled: "var(--color-rose-500)",
    archived: "var(--muted-foreground)",
  } satisfies Record<TicketSummary["status"], string>;
  const statusItems = currentDashboard.statusCounts
    .filter((item) => item.count > 0)
    .map((item) => ({
      label: statusLabels[item.status],
      value: item.count,
      color: statusColors[item.status],
    }));
  const categoryItems = currentDashboard.topCategories.slice(0, 6).map((item) => ({
    label: item.category.label,
    value: item.count,
    color: item.category.color ?? undefined,
  }));
  const chartPeriodDescription = currentDashboard.period
    ? "Criações e resoluções dentro do período"
    : "Todo o período · gráfico dos últimos 14 dias";
  const rankingItems = currentDashboard.topGroups.map((group) => ({
    id: group.groupId,
    label: group.groupSubject,
    count: group.count,
  }));
  const priorityColors = {
    urgent: "var(--destructive)",
    high: "var(--chart-3)",
    normal: "var(--chart-1)",
    low: "var(--muted-foreground)",
  } satisfies Record<TicketSummary["priority"], string>;
  const priorityItems = currentDashboard.priorityCounts
    .filter((item) => item.count > 0)
    .map((item) => ({
      label: priorityLabels[item.priority],
      value: item.count,
      color: priorityColors[item.priority],
    }));
  const comparisonRange = currentDashboard.comparison
    ? formatDashboardRangeLabel(
        {
          from: currentDashboard.comparison.previousPeriod.from,
          to: currentDashboard.comparison.previousPeriod.to,
        },
        timeZone,
      )
    : null;
  const overviewMetrics = [
    {
      label: "Tickets criados",
      value: formatNumber(currentDashboard.totals.tickets),
      note: `${currentDashboard.totals.open} ainda abertos neste recorte`,
      tone: "violet",
      icon: <Inbox size={20} />,
      comparison: comparisonPresentation(currentDashboard.comparison?.created),
    },
    {
      label: "Resolvidos no período",
      value: formatNumber(currentDashboard.totals.resolved),
      note: "Resoluções concluídas dentro do recorte",
      tone: "green",
      icon: <CheckCircle2 size={20} />,
      comparison: comparisonPresentation(
        currentDashboard.comparison?.resolved,
        "higher",
      ),
    },
    {
      label: "Taxa de resolução",
      value: currentDashboard.operations.resolutionRatePercent === null
        ? "—"
        : `${currentDashboard.operations.resolutionRatePercent.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`,
      note: "Resolvidos no período em relação aos criados",
      tone: "blue",
      icon: <Gauge size={20} />,
      comparison: comparisonPresentation(
        currentDashboard.comparison?.resolutionRatePercent,
        "higher",
      ),
    },
    {
      label: "Tempo mediano de resolução",
      value: formatDuration(currentDashboard.operations.medianResolutionMinutes),
      note: "Tempo típico entre abertura e resolução",
      tone: "neutral",
      icon: <TimerReset size={20} />,
      comparison: comparisonPresentation(
        currentDashboard.comparison?.medianResolutionMinutes,
        "lower",
      ),
    },
  ];
  const healthMetrics = [
    {
      label: "Ainda abertos",
      value: currentDashboard.totals.open,
      note: "Criados no recorte e ainda não concluídos",
      icon: <Clock3 size={16} />,
      comparison: null,
    },
    {
      label: "Sem responsável",
      value: currentDashboard.operations.unassignedBacklog,
      note: "Tickets abertos sem uma pessoa atribuída",
      icon: <UserMinus size={16} />,
      comparison: comparisonPresentation(
        currentDashboard.comparison?.unassignedBacklog,
        "lower",
      ),
    },
    {
      label: "Em revisão",
      value: currentDashboard.totals.needsReview,
      note: "Tickets que ainda precisam de validação humana",
      icon: <MessageSquareWarning size={16} />,
      comparison: null,
    },
    {
      label: "Tickets reabertos",
      value: currentDashboard.operations.reopened,
      note: "Voltaram ao atendimento após uma resolução",
      icon: <RotateCcw size={16} />,
      comparison: comparisonPresentation(
        currentDashboard.comparison?.reopened,
        "lower",
      ),
    },
  ];
  const widgetContent = {
    overview: (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {overviewMetrics.map((metric) => (
          <DashboardMetricCard key={metric.label} {...metric} />
        ))}
      </div>
    ),
    health: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          action={comparisonRange ? (
            <Badge className="shrink-0" variant="outline">
              anterior: {comparisonRange}
            </Badge>
          ) : undefined}
          description="Sinais acionáveis que merecem atenção da equipe"
          icon={<ShieldAlert size={17} />}
          title="Saúde da operação"
        />
        <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
          {healthMetrics.map((metric) => (
            <div className="min-w-0 rounded-xl border bg-muted/20 p-3" key={metric.label}>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="text-primary">{metric.icon}</span>
                {metric.label}
              </div>
              <strong className="mt-2 block text-xl font-semibold tracking-tight text-foreground">
                {formatNumber(metric.value)}
              </strong>
              <p className="mt-1 text-xs text-muted-foreground">{metric.note}</p>
              {metric.comparison ? (
                <Badge
                  className={cn(
                    "mt-2 border-0",
                    metric.comparison.tone === "positive" && "bg-emerald-500/10 text-emerald-700",
                    metric.comparison.tone === "negative" && "bg-red-500/10 text-red-700",
                  )}
                  variant="secondary"
                >
                  {metric.comparison.label}
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      </Card>
    ),
    team: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          action={(
            <Badge className="shrink-0" variant="secondary">
              {currentDashboard.assigneeMetrics.filter((metric) => metric.assignee).length} pessoas
            </Badge>
          )}
          description="Criados e abertos no recorte; resolvidos pela data da conclusão"
          icon={<UsersRound size={17} />}
          title="Atendimento por responsável"
        />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {currentDashboard.assigneeMetrics.map((metric) => {
            const filterValue = metric.assignee?.id ?? unassignedFilter;
            const selected = selectedAssignee === filterValue;
            const displayName = metric.assignee?.displayName ?? "Sem responsável";
            const initials = metric.assignee
              ? metric.assignee.displayName
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((part) => part[0]?.toLocaleUpperCase("pt-BR"))
                  .join("")
              : "—";
            return (
              <Button
                aria-pressed={selected}
                className={cn(
                  "grid min-h-24 min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border bg-background p-3 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-primary/5",
                  selected && "border-primary bg-primary/5 ring-1 ring-primary/20",
                )}
                key={filterValue}
                onClick={() => selectAssignee(filterValue)}
                size="unstyled"
                type="button"
                variant="unstyled"
              >
                <span className="row-span-2 grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {initials}
                </span>
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <strong className="truncate text-sm font-semibold text-foreground">{displayName}</strong>
                  <Badge className="shrink-0" variant={selected ? "default" : "outline"}>
                    {selected
                      ? "Filtrado"
                      : metric.assignee
                        ? metric.assignee.active ? "Ativo" : "Inativo"
                        : "Fila"}
                  </Badge>
                </span>
                <span className="grid min-w-0 grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <span className="flex flex-col"><b className="text-sm text-foreground">{formatNumber(metric.created)}</b>Criados</span>
                  <span className="flex flex-col"><b className="text-sm text-foreground">{formatNumber(metric.open)}</b>Abertos</span>
                  <span className="flex flex-col"><b className="text-sm text-foreground">{formatNumber(metric.resolved)}</b>Resolvidos</span>
                </span>
              </Button>
            );
          })}
        </div>
        {!currentDashboard.assigneeMetrics.length ? (
          <p className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
            Adicione pessoas à equipe para acompanhar a distribuição dos tickets.
          </p>
        ) : null}
      </Card>
    ),
    rhythm: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          action={(
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-sm bg-[var(--chart-1)]" />Criados</span>
              <span className="inline-flex items-center gap-1.5"><i className="size-2 rounded-sm bg-[var(--chart-4)]" />Resolvidos</span>
            </div>
          )}
          description={chartPeriodDescription}
          icon={<TrendingUp size={17} />}
          title="Ritmo do atendimento"
        />
        {currentDashboard.ticketsByDay.length ? (
          <DashboardDailyChart data={currentDashboard.ticketsByDay} />
        ) : (
          <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Não houve criação ou resolução neste período.</p>
        )}
      </Card>
    ),
    audit: (
      <Card className="min-w-0 gap-4 bg-linear-to-br from-card to-amber-50/40 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Proteção contra mensagens perdidas"
          icon={<ShieldAlert size={17} />}
          title="Auditoria de demandas"
        />
        <div className={cn(
          "flex items-center gap-2.5 rounded-lg border p-3 text-emerald-700",
          currentDashboard.totals.orphanDemands
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-emerald-200 bg-emerald-50",
        )}>
          {currentDashboard.totals.orphanDemands ? <AlertTriangle size={25} /> : <CheckCircle2 size={25} />}
          <div className="flex flex-col">
            <strong className="text-sm font-semibold">{currentDashboard.totals.orphanDemands ? `${currentDashboard.totals.orphanDemands} conversas` : "Fila em dia"}</strong>
            <span className="mt-0.5 text-xs text-muted-foreground">{currentDashboard.totals.orphanDemands ? "podem conter demandas sem ticket" : "Nenhuma demanda órfã detectada"}</span>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Este número representa a fila atual e não é limitado pelo filtro de datas.</p>
        <Button className="w-full" onClick={onOpenInbox} type="button" variant="outline">Revisar na Inbox <ArrowRight size={15} /></Button>
      </Card>
    ),
    status: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Resultado dos tickets do período, mesmo após arquivar"
          icon={<ChartPie size={17} />}
          title="Status dos tickets criados"
        />
        {statusItems.length ? <DashboardStatusDonut items={statusItems} /> : <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Sem tickets categorizados.</p>}
      </Card>
    ),
    categories: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Assuntos dos tickets criados no período"
          icon={<Clock3 size={17} />}
          title="Categorias mais frequentes"
        />
        {categoryItems.length ? <DashboardHorizontalBars items={categoryItems} /> : <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">As categorias aparecerão com os tickets.</p>}
      </Card>
    ),
    priority: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Urgência dos tickets criados no período"
          icon={<AlertTriangle size={17} />}
          title="Tickets por prioridade"
        />
        {priorityItems.length ? <DashboardHorizontalBars items={priorityItems} /> : <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">As prioridades aparecerão com os tickets.</p>}
      </Card>
    ),
    groups: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Grupos com mais tickets no período"
          icon={<MessagesSquare size={17} />}
          title="Tickets por grupo"
        />
        <ol className="grid list-none gap-1.5 p-0">
          {rankingItems.slice(0, 5).map((item, index) => (
            <li className="grid min-h-8 grid-cols-[24px_minmax(0,1fr)_28px] items-center gap-2" key={item.id}>
              <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
              <strong className="truncate text-xs font-medium text-foreground">{item.label}</strong>
              <b className="text-right text-xs text-muted-foreground">{item.count}</b>
            </li>
          ))}
        </ol>
        {!rankingItems.length ? <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Sem tickets neste agrupamento.</p> : null}
      </Card>
    ),
    recent: (
      <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
        <DashboardPanelHeader
          description="Últimas demandas criadas no recorte"
          icon={<Inbox size={17} />}
          title="Tickets recentes do período"
        />
        <div className="grid gap-1.5">
          {currentDashboard.recentTickets.slice(0, 6).map((ticket: TicketSummary) => (
            <Button
              className="grid min-h-10 w-full grid-cols-[minmax(160px,1.5fr)_minmax(90px,.8fr)_auto_18px] items-center gap-2 rounded-lg border border-border bg-background px-2 text-left text-xs hover:bg-muted/60"
              key={ticket.id}
              onClick={() => onOpenTicket(ticket.id)}
              size="unstyled"
              type="button"
              variant="unstyled"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <small className="text-xs font-semibold text-primary">#{ticket.number}</small>
                <strong className="truncate font-medium text-foreground">{ticket.title}</strong>
              </span>
              <span className="truncate text-muted-foreground">{getClientName(ticket)}</span>
              <Badge
                className="justify-self-start text-xs"
                variant={ticket.status === "resolved" ? "secondary" : ticket.status === "new" || ticket.status === "triage" ? "default" : "outline"}
              >
                {statusLabels[ticket.status]}
              </Badge>
              <ArrowRight size={14} />
            </Button>
          ))}
          {!currentDashboard.recentTickets.length ? <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Nenhum ticket criado neste período.</p> : null}
        </div>
      </Card>
    ),
  } satisfies Record<string, ReactNode>;
  return (
    <div aria-busy={filterLoading} className="min-h-full w-full p-4 sm:p-5">
      {toolbar}
      {loadError ? (
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <span className="min-w-0 break-words">{loadError}</span>
          <Button onClick={retryDashboard} size="sm" type="button" variant="outline">
            Tentar novamente
          </Button>
        </div>
      ) : null}
      <section className="grid grid-flow-row-dense items-start gap-3 lg:grid-cols-12">
        <div className="lg:col-span-12">{widgetContent.overview}</div>
        <div className="lg:col-span-12">{widgetContent.health}</div>
        <div className="lg:col-span-12">{widgetContent.team}</div>
        <div className="lg:col-span-12">{widgetContent.rhythm}</div>
        <div className="lg:col-span-4">{widgetContent.audit}</div>
        <div className="lg:col-span-4">{widgetContent.status}</div>
        <div className="lg:col-span-4">{widgetContent.categories}</div>
        <div className="lg:col-span-4">{widgetContent.priority}</div>
        <div className="lg:col-span-4">{widgetContent.groups}</div>
        <div className="lg:col-span-4">{widgetContent.recent}</div>
      </section>
    </div>
  );
}
