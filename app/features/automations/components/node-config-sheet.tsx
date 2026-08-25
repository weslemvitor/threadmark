"use client";

import { useRef } from "react";
import { AlertTriangle, Braces, Check, Settings2, Trash2 } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import {
  automationConditionValueOptions,
  getAutomationConfigValue,
  insertAutomationTemplateVariable,
  setAutomationConfigValue,
  automationTemplateVariables,
  type AutomationNodeConfigValue,
  type AutomationNodeDefinition,
  type AutomationNodeField,
  type AutomationNodeDto,
  type AutomationValidationIssue,
} from "../domain";

type NodeConfigSheetProps = {
  definition: AutomationNodeDefinition | null;
  issues: AutomationValidationIssue[];
  node: AutomationNodeDto | null;
  onChange: (node: AutomationNodeDto) => void;
  onDelete: (nodeId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

function displayValue(
  value: AutomationNodeConfigValue | undefined,
  multiplier?: number,
): string | number {
  if (typeof value === "number" && multiplier) return value / multiplier;
  return typeof value === "string" || typeof value === "number" ? value : "";
}

function durationUnit(
  field: AutomationNodeField,
  configuredUnit: AutomationNodeConfigValue | undefined,
  durationMs: AutomationNodeConfigValue | undefined,
) {
  const units = field.durationUnits ?? [];
  const configured = units.find((unit) => unit.value === configuredUnit);
  if (configured) return configured;
  if (typeof durationMs === "number") {
    const inferred = [...units]
      .sort((left, right) => right.multiplier - left.multiplier)
      .find((unit) => durationMs >= unit.multiplier && durationMs % unit.multiplier === 0);
    if (inferred) return inferred;
  }
  return units[0];
}

function durationDisplayValue(
  durationMs: AutomationNodeConfigValue | undefined,
  multiplier: number,
): string | number {
  if (typeof durationMs !== "number") return "";
  return Number((durationMs / multiplier).toFixed(4));
}

function capacityRows(value: AutomationNodeConfigValue | undefined) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return [];
    const assigneeId = item.assigneeId;
    const maxTickets = item.maxTickets;
    if (typeof assigneeId !== "string") return [];
    return [{
      assigneeId,
      maxTickets: typeof maxTickets === "number" ? maxTickets : 5,
    }];
  });
}

export function NodeConfigSheet({
  definition,
  issues,
  node,
  onChange,
  onDelete,
  onOpenChange,
  open,
}: NodeConfigSheetProps) {
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  if (!node || !definition) return null;
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const conditionOperator = node.type === "condition"
    ? getAutomationConfigValue(node.config, "operator")
    : null;
  const conditionField = node.type === "condition"
    ? getAutomationConfigValue(node.config, "field")
    : null;

  function change(path: string, value: AutomationNodeConfigValue) {
    let config = setAutomationConfigValue(node!.config, path, value);
    if (node!.type === "condition" && path === "field") {
      config = setAutomationConfigValue(config, "value", "");
    }
    onChange({ ...node!, config });
  }

  function insertVariable(path: string, token: string) {
    const stored = getAutomationConfigValue(node!.config, path);
    const current = typeof stored === "string" ? stored : "";
    const field = fieldRefs.current[path];
    const start = field?.selectionStart ?? current.length;
    const end = field?.selectionEnd ?? start;
    const insertion = insertAutomationTemplateVariable(current, token, start, end);
    change(path, insertion.value);
    requestAnimationFrame(() => {
      const updatedField = fieldRefs.current[path];
      updatedField?.focus();
      updatedField?.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  function changeDuration(
    field: AutomationNodeField,
    amount: number,
    unitValue: string,
  ) {
    const unit = field.durationUnits?.find((candidate) => candidate.value === unitValue);
    if (!unit) return;
    let config = setAutomationConfigValue(
      node!.config,
      field.key,
      Math.round(amount * unit.multiplier),
    );
    config = setAutomationConfigValue(
      config,
      field.durationUnitKey ?? "durationUnit",
      unit.value,
    );
    onChange({ ...node!, config });
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="bg-muted">
        <SheetHeader className="bg-background">
          <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
            <Settings2 className="size-3.5" /> Configurar etapa
          </div>
          <SheetTitle className="text-lg">{definition.label}</SheetTitle>
          <SheetDescription>{definition.description}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid gap-3 p-4">
            <section className="rounded-xl border bg-background p-4 shadow-xs">
              <label className="grid gap-1.5 text-xs font-medium">
                Nome desta etapa
                <Input
                  maxLength={100}
                  onChange={(event) => onChange({ ...node, name: event.target.value })}
                  placeholder={definition.label}
                  value={node.name ?? ""}
                />
                <span className="font-normal leading-relaxed text-muted-foreground">Opcional; ajuda a identificar a etapa no fluxo.</span>
              </label>
            </section>

            {definition.fields.length ? (
              <section className="rounded-xl border bg-background p-4 shadow-xs">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold">Configuração</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">Defina como esta etapa deve se comportar.</p>
                </div>
                <div className="grid gap-4">
                {definition.fields.map((field) => {
              if (
                field.key === "value" &&
                (conditionOperator === "exists" || conditionOperator === "not_exists")
              ) {
                return null;
              }
              const storedValue = getAutomationConfigValue(node.config, field.key);
              const configuredDurationUnit = field.type === "duration"
                ? getAutomationConfigValue(
                    node.config,
                    field.durationUnitKey ?? "durationUnit",
                  )
                : undefined;
              const selectedDurationUnit = field.type === "duration"
                ? durationUnit(field, configuredDurationUnit, storedValue)
                : undefined;
              const value = selectedDurationUnit
                ? durationDisplayValue(storedValue, selectedDurationUnit.multiplier)
                : displayValue(storedValue, field.storageMultiplier);
              const conditionValueOptions = node.type === "condition" && field.key === "value"
                ? automationConditionValueOptions(conditionField)
                : [];
              const fieldId = `automation-${node.id}-${field.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              const configuredCapacities = field.type === "assignee_capacities"
                ? capacityRows(storedValue)
                : [];
              return (
                <div className="grid gap-1.5 text-xs font-medium" key={field.key}>
                  <label htmlFor={fieldId}>{field.label}{field.required ? " *" : ""}</label>
                  {field.type === "textarea" ? (
                    <Textarea
                      className="min-h-28 resize-y"
                      id={fieldId}
                      onChange={(event) => change(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      ref={(element) => { fieldRefs.current[field.key] = element; }}
                      value={value}
                    />
                  ) : null}
                  {field.type === "select" ? (
                    <Select
                      onValueChange={(nextValue) => change(field.key, nextValue)}
                      value={typeof value === "string" && value ? value : undefined}
                    >
                      <SelectTrigger className="w-full" id={fieldId}>
                        <SelectValue placeholder="Selecione uma opção" />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options?.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {field.type === "number" ? (
                    <Input
                      id={fieldId}
                      max={field.max}
                      min={field.min}
                      onChange={(event) => {
                        const numeric = Number(event.target.value);
                        change(field.key, numeric * (field.storageMultiplier ?? 1));
                      }}
                      type="number"
                      value={value}
                    />
                  ) : null}
                  {field.type === "duration" && selectedDurationUnit ? (
                    <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
                      <Input
                        id={fieldId}
                        max={Math.floor(31_536_000_000 / selectedDurationUnit.multiplier)}
                        min={field.min ?? 1}
                        onChange={(event) => {
                          const numeric = Number(event.target.value);
                          changeDuration(field, numeric, selectedDurationUnit.value);
                        }}
                        step="any"
                        type="number"
                        value={value}
                      />
                      <Select
                        onValueChange={(nextValue) => {
                          const numeric = Number(value);
                          changeDuration(field, numeric, nextValue);
                        }}
                        value={selectedDurationUnit.value}
                      >
                        <SelectTrigger aria-label="Unidade do tempo de espera" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {field.durationUnits?.map((unit) => (
                            <SelectItem key={unit.value} value={unit.value}>{unit.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {field.type === "text" && conditionValueOptions.length ? (
                    <Select
                      onValueChange={(nextValue) => change(field.key, nextValue)}
                      value={typeof value === "string" && value ? value : undefined}
                    >
                      <SelectTrigger className="w-full" id={fieldId}>
                        <SelectValue placeholder="Selecione um valor" />
                      </SelectTrigger>
                      <SelectContent>
                        {conditionValueOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {field.type === "text" && !conditionValueOptions.length ? (
                    <Input
                      id={fieldId}
                      onChange={(event) => change(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      ref={(element) => { fieldRefs.current[field.key] = element; }}
                      value={value}
                    />
                  ) : null}
                  {field.type === "boolean" ? (
                    <span className="flex items-center justify-between rounded-lg border p-3">
                      <span className="font-normal text-muted-foreground">Ativado</span>
                      <Switch
                        checked={storedValue === true}
                        onCheckedChange={(checked) => change(field.key, checked)}
                      />
                    </span>
                  ) : null}
                  {field.type === "assignee_capacities" ? (
                    <div className="grid gap-2" id={fieldId}>
                      {field.options?.length ? field.options.map((option) => {
                        const configured = configuredCapacities.find(
                          (item) => item.assigneeId === option.value,
                        );
                        return (
                          <div
                            className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-3 rounded-lg border bg-muted/30 p-3"
                            key={option.value}
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <Switch
                                aria-label={`Incluir ${option.label} na distribuição`}
                                checked={Boolean(configured)}
                                onCheckedChange={(checked) => {
                                  const next = checked
                                    ? [...configuredCapacities, { assigneeId: option.value, maxTickets: 5 }]
                                    : configuredCapacities.filter(
                                        (item) => item.assigneeId !== option.value,
                                      );
                                  change(field.key, next);
                                }}
                              />
                              <span className="min-w-0 truncate font-medium">{option.label}</span>
                            </div>
                            <label className="grid gap-1 text-[11px] text-muted-foreground">
                              Máximo
                              <Input
                                aria-label={`Máximo de tickets para ${option.label}`}
                                disabled={!configured}
                                max={500}
                                min={1}
                                onChange={(event) => {
                                  const maxTickets = Number(event.target.value);
                                  change(
                                    field.key,
                                    configuredCapacities.map((item) =>
                                      item.assigneeId === option.value
                                        ? { ...item, maxTickets }
                                        : item,
                                    ),
                                  );
                                }}
                                type="number"
                                value={configured?.maxTickets ?? 5}
                              />
                            </label>
                          </div>
                        );
                      }) : (
                        <p className="rounded-lg border border-dashed p-3 text-xs font-normal text-muted-foreground">
                          Nenhum usuário ativo está disponível. Cadastre a equipe nas configurações.
                        </p>
                      )}
                    </div>
                  ) : null}
                  {field.description ? <span className="font-normal text-muted-foreground">{field.description}</span> : null}
                  {field.supportsVariables ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button className="w-fit" size="sm" type="button" variant="outline">
                          <Braces /> Inserir variável
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-72" sideOffset={6}>
                      {(["Ticket", "Atendimento", "Pessoas"] as const).map((group) => (
                        <DropdownMenuGroup key={group}>
                          <DropdownMenuLabel>{group}</DropdownMenuLabel>
                          {automationTemplateVariables
                            .filter((variable) => variable.group === group)
                            .map((variable) => (
                              <DropdownMenuItem
                                className="flex-col items-start gap-0.5 px-2 py-1.5"
                                key={variable.token}
                                onSelect={() => insertVariable(field.key, variable.token)}
                              >
                                <span className="text-xs font-medium">{variable.label}</span>
                                <span className="font-mono text-[10px] text-muted-foreground">{variable.token}</span>
                              </DropdownMenuItem>
                            ))}
                          {group !== "Pessoas" ? <DropdownMenuSeparator /> : null}
                        </DropdownMenuGroup>
                      ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              );
                })}
                </div>
              </section>
            ) : null}

            {!definition.fields.length ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-800">
                Esta etapa não exige configuração adicional.
              </div>
            ) : null}

            {nodeIssues.length ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <strong className="flex items-center gap-2 text-xs text-amber-900"><AlertTriangle size={15} /> Revisar etapa</strong>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-amber-800">
                  {nodeIssues.map((issue) => <li key={issue.id}>{issue.message}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background p-4">
          <Button onClick={() => onDelete(node.id)} size="sm" type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
            <Trash2 /> Excluir etapa
          </Button>
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            <Check /> Concluir
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
