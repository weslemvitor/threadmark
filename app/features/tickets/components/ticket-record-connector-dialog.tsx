"use client";

import { Braces, LoaderCircle, PlugZap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/app/components/ui/button";
import { Checkbox } from "@/app/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { getRecordConnectorCatalog } from "@/app/lib/api";
import type {
  DirectorySnapshotDto,
  ExecuteRecordConnectorInput,
  RecordConnectorExecutionValue,
  RecordConnectorSummaryDto,
  TicketDetailDto,
} from "@/shared/contracts";

export function TicketRecordConnectorDialog({
  ticket,
  directory,
  executing,
  onClose,
  onExecute,
  onOpenConnectors,
}: {
  ticket: TicketDetailDto;
  directory: DirectorySnapshotDto | null;
  executing: boolean;
  onClose(): void;
  onExecute(
    connectorId: string,
    input: ExecuteRecordConnectorInput,
  ): Promise<boolean>;
  onOpenConnectors(): void;
}) {
  const [connectors, setConnectors] = useState<RecordConnectorSummaryDto[]>([]);
  const [connectorId, setConnectorId] = useState("");
  const [values, setValues] = useState<
    Record<string, RecordConnectorExecutionValue>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const connector = connectors.find((item) => item.id === connectorId) ?? null;
  const recordTypeName = useMemo(
    () =>
      directory?.recordTypes.find(
        (recordType) => recordType.id === connector?.targetRecordTypeId,
      )?.name ?? "registro do Diretório",
    [connector?.targetRecordTypeId, directory?.recordTypes],
  );

  useEffect(() => {
    let cancelled = false;
    void getRecordConnectorCatalog()
      .then((items) => {
        if (cancelled) return;
        setConnectors(items);
        setConnectorId(items[0]?.id ?? "");
        setValues(initialValues(items[0] ?? null));
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Não foi possível carregar os conectores.",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    if (!connector) return;
    for (const field of connector.inputFields) {
      const value = values[field.key];
      if (
        field.required &&
        (value === undefined || value === null || value === "")
      ) {
        setError(`${field.label} é obrigatório.`);
        return;
      }
    }
    setError(null);
    const saved = await onExecute(connector.id, {
      clientRequestId: crypto.randomUUID(),
      values,
    });
    if (saved) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !executing) onClose();
      }}
    >
      <DialogContent showCloseButton={!executing}>
        <DialogHeader>
          <DialogTitle>Criar registro via conector</DialogTitle>
          <DialogDescription>
            Execute uma ação configurada e vincule o registro criado ao ticket #
            {ticket.number}.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div
            className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="animate-spin" size={17} />
            Carregando conectores…
          </div>
        ) : connectors.length ? (
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-xs font-medium">
              Ação
              <Select
                disabled={executing}
                onValueChange={(nextConnectorId) => {
                  setConnectorId(nextConnectorId);
                  setValues(
                    initialValues(
                      connectors.find(
                        (item) => item.id === nextConnectorId,
                      ) ?? null,
                    ),
                  );
                  setError(null);
                }}
                value={connectorId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connectors.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {connector ? (
              <>
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                  <strong className="block text-foreground">
                    {connector.method} · cria {recordTypeName}
                  </strong>
                  {connector.description ??
                    "A resposta será salva como um registro do Diretório."}
                </div>
                <div className="grid gap-3">
                  {connector.inputFields.map((field) =>
                    field.type === "boolean" ? (
                      <label
                        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-xs font-medium"
                        key={field.key}
                      >
                        <Checkbox
                          checked={values[field.key] === true}
                          disabled={executing}
                          onCheckedChange={(checked) =>
                            setValues((current) => ({
                              ...current,
                              [field.key]: checked === true,
                            }))
                          }
                        />
                        {field.label}
                      </label>
                    ) : (
                      <label
                        className="grid gap-1.5 text-xs font-medium"
                        key={field.key}
                      >
                        {field.label}
                        <Input
                          disabled={executing}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [field.key]:
                                field.type === "number"
                                  ? event.target.value
                                    ? Number(event.target.value)
                                    : null
                                  : event.target.value,
                            }))
                          }
                          placeholder={field.placeholder ?? undefined}
                          required={field.required}
                          type={field.type === "number" ? "number" : "text"}
                          value={
                            typeof values[field.key] === "string" ||
                            typeof values[field.key] === "number"
                              ? String(values[field.key])
                              : ""
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
              </>
            ) : null}
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid justify-items-center rounded-xl border border-dashed border-border px-5 py-8 text-center">
            <PlugZap className="text-muted-foreground" size={23} />
            <strong className="mt-3 text-sm text-foreground">
              Nenhum conector disponível
            </strong>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Configure uma ação HTTP e escolha o tipo de registro que ela cria.
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                onClose();
                onOpenConnectors();
              }}
              type="button"
              variant="outline"
            >
              Abrir Conectores
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={executing}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancelar
          </Button>
          {connectors.length ? (
            <Button
              disabled={executing || !connector}
              onClick={() => void submit()}
              type="button"
              variant="default"
            >
              {executing ? (
                <LoaderCircle className="animate-spin" size={14} />
              ) : (
                <Braces size={14} />
              )}
              Criar e vincular
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function initialValues(
  connector: RecordConnectorSummaryDto | null,
): Record<string, RecordConnectorExecutionValue> {
  return Object.fromEntries(
    (connector?.inputFields ?? []).map((field) => [
      field.key,
      field.type === "boolean" ? false : null,
    ]),
  );
}
