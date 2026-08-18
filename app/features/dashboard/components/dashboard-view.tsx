import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ChartPie,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Download,
  Inbox,
  LoaderCircle,
  MessageSquareWarning,
  MessagesSquare,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
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
import { formatNumber, getClientName, statusLabels } from "@/app/lib/format";
import type { DashboardData, TicketSummary } from "@/app/lib/types";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { NativeSelect } from "@/app/components/ui/native-select";
import { EmptyState, LoadingState } from "@/app/components/shared/ui-states";
import { cn } from "@/app/lib/utils";
import {
  DashboardDailyChart,
  DashboardHorizontalBars,
  DashboardMetricCard,
  DashboardStatusDonut,
} from "./dashboard-charts";

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
    rangeKey: string;
    data: DashboardData;
  } | null>(null);
  const rangeFrom = range.from;
  const rangeTo = range.to;
  const activeRangeKey = dashboardRangeKey(range);
  const today = initialRange.to ?? "";

  useEffect(() => {
    let active = true;
    const requestedRange = { from: rangeFrom, to: rangeTo };
    const requestedKey = dashboardRangeKey(requestedRange);
    void getDashboard(requestedRange)
      .then((data) => {
        if (active) setLoadedDashboard({ rangeKey: requestedKey, data });
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
  }, [dashboard, rangeFrom, rangeTo, reloadVersion]);

  const currentDashboard =
    loadedDashboard?.rangeKey === activeRangeKey
      ? loadedDashboard.data
      : activeRangeKey === "all:all"
        ? dashboard
        : null;
  const effectiveRange = currentDashboard?.period
    ? { from: currentDashboard.period.from, to: currentDashboard.period.to }
    : range;
  const rangeLabel = formatDashboardRangeLabel(effectiveRange, timeZone);

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
      const result = await getDashboardExport(range);
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
      aria-label="Filtrar indicadores por período"
      className="mb-4 grid gap-3 p-3 py-3 shadow-sm lg:grid-cols-[minmax(210px,1fr)_auto]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <CalendarDays size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <strong className="text-sm font-semibold text-foreground">Período dos indicadores</strong>
          <small className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Tickets criados e resoluções de {rangeLabel}</small>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-2 lg:justify-end">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Período</span>
          <NativeSelect
            aria-label="Selecionar período do dashboard"
            className="h-9 min-w-40 text-sm"
            onChange={(event) => selectPeriod(event.target.value as DashboardPeriodId)}
            value={selectedPeriod}
            wrapperClassName="w-full sm:w-fit"
          >
            {dashboardPeriodOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </NativeSelect>
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
      <section className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DashboardMetricCard
          label="Tickets criados"
          value={formatNumber(currentDashboard.totals.tickets)}
          note={`${currentDashboard.totals.open} ainda abertos neste recorte`}
          tone="violet"
          icon={<Inbox size={20} />}
        />
        <DashboardMetricCard
          label="Aguardando revisão"
          value={formatNumber(currentDashboard.totals.needsReview)}
          note="Entre os tickets criados no período"
          tone="blue"
          icon={<CircleDashed size={20} />}
        />
        <DashboardMetricCard
          label="Resolvidos no período"
          value={formatNumber(currentDashboard.totals.resolved)}
          note="Resoluções concluídas dentro do recorte"
          tone="green"
          icon={<CheckCircle2 size={20} />}
        />
        <DashboardMetricCard
          label="Demandas órfãs agora"
          value={formatNumber(currentDashboard.totals.orphanDemands)}
          note="Snapshot atual da fila de auditoria"
          tone={currentDashboard.totals.orphanDemands ? "amber" : "neutral"}
          icon={<MessageSquareWarning size={20} />}
        />
      </section>

      <section className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm lg:col-span-2">
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

        <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
          <DashboardPanelHeader
            description="Estado atual dos tickets do período"
            icon={<ChartPie size={17} />}
            title="Status dos tickets criados"
          />
          {statusItems.length ? <DashboardStatusDonut items={statusItems} /> : <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Sem tickets categorizados.</p>}
        </Card>

        <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm">
          <DashboardPanelHeader
            description="Assuntos dos tickets criados no período"
            icon={<Clock3 size={17} />}
            title="Categorias mais frequentes"
          />
          {categoryItems.length ? <DashboardHorizontalBars items={categoryItems} /> : <p className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">As categorias aparecerão com os tickets.</p>}
        </Card>

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

        <Card className="min-w-0 gap-4 p-4 py-4 shadow-sm lg:col-span-2">
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
      </section>
    </div>
  );
}
