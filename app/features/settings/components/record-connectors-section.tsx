"use client";

import {
  Braces,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Trash2,
  Unplug,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/app/components/ui/alert-dialog";
import { Badge } from "@/app/components/ui/badge";
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
import { Textarea } from "@/app/components/ui/textarea";
import {
  archiveRecordConnector,
  createRecordConnector,
  updateRecordConnector,
} from "@/app/lib/settings";
import type {
  DirectorySnapshotDto,
  RecordConnectorDto,
  RecordConnectorFieldMappingDto,
  RecordConnectorInputFieldDto,
  RecordConnectorInputType,
  RecordConnectorMethod,
  RecordConnectorWriteInput,
} from "@/shared/contracts";

type Draft = {
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
  method: RecordConnectorMethod;
  urlTemplate: string;
  headersTemplate: string;
  bodyTemplate: string;
  token: string;
  targetRecordTypeId: string;
  recordNamePath: string;
  recordDescriptionPath: string;
  inputFields: RecordConnectorInputFieldDto[];
  fieldMappings: RecordConnectorFieldMappingDto[];
};

const emptyDraft: Draft = {
  id: null,
  name: "",
  description: "",
  enabled: true,
  method: "POST",
  urlTemplate: "https://api.exemplo.com/records",
  headersTemplate: '{\n  "Authorization": "Bearer {{token}}"\n}',
  bodyTemplate:
    '{\n  "title": "{{input.title}}",\n  "description": "{{ticket.summary}}"\n}',
  token: "",
  targetRecordTypeId: "",
  recordNamePath: "response.title",
  recordDescriptionPath: "",
  inputFields: [
    {
      key: "title",
      label: "Título",
      type: "text",
      required: true,
      placeholder: "Título no sistema externo",
    },
  ],
  fieldMappings: [],
};

export function RecordConnectorsSection({
  canManage,
  connectors,
  directory,
  onChange,
  onFeedback,
}: {
  canManage: boolean;
  connectors: RecordConnectorDto[];
  directory: DirectorySnapshotDto | null;
  onChange(value: RecordConnectorDto[]): void;
  onFeedback(tone: "success" | "error", message: string): void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const recordTypeById = useMemo(
    () =>
      new Map(
        (directory?.recordTypes ?? []).map((recordType) => [
          recordType.id,
          recordType,
        ]),
      ),
    [directory],
  );

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const input: RecordConnectorWriteInput = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        enabled: draft.enabled,
        method: draft.method,
        urlTemplate: draft.urlTemplate.trim(),
        headersTemplate: draft.headersTemplate.trim() || "{}",
        bodyTemplate: draft.bodyTemplate.trim() || "{}",
        targetRecordTypeId: draft.targetRecordTypeId,
        recordNamePath: draft.recordNamePath.trim(),
        recordDescriptionPath:
          draft.recordDescriptionPath.trim() || null,
        inputFields: draft.inputFields,
        fieldMappings: draft.fieldMappings,
        ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
      };
      const saved = draft.id
        ? await updateRecordConnector(draft.id, input)
        : await createRecordConnector(input);
      onChange(
        draft.id
          ? connectors.map((connector) =>
              connector.id === saved.id ? saved : connector,
            )
          : [...connectors, saved],
      );
      onFeedback(
        "success",
        draft.id ? "Conector atualizado." : "Conector criado.",
      );
      setDraft(null);
    } catch (error) {
      onFeedback(
        "error",
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o conector.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function archive(connector: RecordConnectorDto) {
    try {
      await archiveRecordConnector(connector.id);
      onChange(connectors.filter((item) => item.id !== connector.id));
      onFeedback("success", "Conector arquivado.");
    } catch (error) {
      onFeedback(
        "error",
        error instanceof Error
          ? error.message
          : "Não foi possível arquivar o conector.",
      );
    }
  }

  return (
    <section>
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Conectores de registros
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Configure chamadas HTTP que criam algo em qualquer sistema e
            materializam a resposta como um registro normal do Diretório.
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => setDraft({ ...emptyDraft })}
            type="button"
            variant="default"
          >
            <Plus size={15} /> Novo conector
          </Button>
        ) : null}
      </header>

      <div className="mt-5 rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs leading-relaxed text-muted-foreground">
        <strong className="block text-foreground">
          Uma ação, vários destinos
        </strong>
        Use o mesmo modelo para Linear, Intercom ou APIs próprias. Tokens ficam
        cifrados fora do SQLite. O resultado aparece em “Registros vinculados”
        no ticket.
      </div>

      <div className="mt-5 grid gap-3">
        {connectors.length ? (
          connectors.map((connector) => (
            <article
              className="rounded-xl border border-border bg-card p-4 shadow-xs"
              key={connector.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm text-foreground">
                      {connector.name}
                    </strong>
                    <Badge variant={connector.enabled ? "secondary" : "outline"}>
                      {connector.enabled ? "Ativo" : "Inativo"}
                    </Badge>
                    <Badge variant="outline">{connector.method}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Cria{" "}
                    {recordTypeById.get(connector.targetRecordTypeId)?.name ??
                      "registro do Diretório"}
                    {connector.hasToken
                      ? ` · token final ${connector.tokenLastFour ?? "configurado"}`
                      : " · sem token"}
                  </p>
                  {connector.description ? (
                    <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                      {connector.description}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex gap-1">
                    <Button
                      onClick={() => setDraft(draftFromConnector(connector))}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Pencil size={13} /> Editar
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          aria-label={`Arquivar ${connector.name}`}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Arquivar {connector.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Ele deixa de aparecer nos tickets. Registros já
                            criados e o histórico de execução são preservados.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => void archive(connector)}
                            variant="destructive"
                          >
                            Arquivar
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <div className="grid justify-items-center rounded-xl border border-dashed border-border px-5 py-10 text-center">
            <Unplug className="text-muted-foreground" size={24} />
            <strong className="mt-3 text-sm text-foreground">
              Nenhum conector criado
            </strong>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
              Crie uma ação HTTP e escolha qual tipo de registro ela produzirá.
            </p>
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open && !saving) setDraft(null);
        }}
      >
        {draft ? (
          <DialogContent
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
            showCloseButton={!saving}
          >
            <DialogHeader>
              <DialogTitle>
                {draft.id ? "Editar conector" : "Novo conector"}
              </DialogTitle>
              <DialogDescription>
                Templates aceitam caminhos como {"{{ticket.title}}"},{" "}
                {"{{ticket.summary}}"}, {"{{input.title}}"} e {"{{token}}"}.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5">
              <div className="grid gap-3 rounded-xl border border-border p-4">
                <SectionTitle title="Identificação" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nome">
                    <Input
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                      placeholder="Criar card no Linear"
                      value={draft.name}
                    />
                  </Field>
                  <label className="flex items-center gap-2 self-end rounded-lg border border-border px-3 py-2 text-xs font-medium">
                    <Checkbox
                      checked={draft.enabled}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, enabled: checked === true })
                      }
                    />
                    Disponível nos tickets
                  </label>
                </div>
                <Field label="Descrição">
                  <Input
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                    placeholder="Explique quando esta ação deve ser usada"
                    value={draft.description}
                  />
                </Field>
              </div>

              <div className="grid gap-3 rounded-xl border border-border p-4">
                <SectionTitle title="Requisição HTTP" />
                <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <Field label="Método">
                    <Select
                      onValueChange={(method) =>
                        setDraft({
                          ...draft,
                          method: method as RecordConnectorMethod,
                        })
                      }
                      value={draft.method}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["POST", "PUT", "PATCH"] as const).map((method) => (
                          <SelectItem key={method} value={method}>
                            {method}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="URL">
                    <Input
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          urlTemplate: event.target.value,
                        })
                      }
                      value={draft.urlTemplate}
                    />
                  </Field>
                </div>
                <Field label="Token de permissão">
                  <Input
                    autoComplete="new-password"
                    onChange={(event) =>
                      setDraft({ ...draft, token: event.target.value })
                    }
                    placeholder={
                      draft.id
                        ? "Deixe vazio para preservar o token atual"
                        : "Token opcional, armazenado cifrado"
                    }
                    type="password"
                    value={draft.token}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Headers (JSON)">
                    <Textarea
                      className="min-h-32 font-mono text-xs"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          headersTemplate: event.target.value,
                        })
                      }
                      value={draft.headersTemplate}
                    />
                  </Field>
                  <Field label="Body (JSON)">
                    <Textarea
                      className="min-h-32 font-mono text-xs"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          bodyTemplate: event.target.value,
                        })
                      }
                      value={draft.bodyTemplate}
                    />
                  </Field>
                </div>
              </div>

              <div className="grid gap-3 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <SectionTitle title="Campos pedidos ao executar" />
                  <Button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        inputFields: [
                          ...draft.inputFields,
                          {
                            key: `campo_${draft.inputFields.length + 1}`,
                            label: "Novo campo",
                            type: "text",
                            required: false,
                            placeholder: null,
                          },
                        ],
                      })
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus size={12} /> Campo
                  </Button>
                </div>
                {draft.inputFields.map((field, index) => (
                  <div
                    className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_130px_auto]"
                    key={`${field.key}:${index}`}
                  >
                    <Input
                      aria-label="Chave do campo"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputFields: replaceAt(draft.inputFields, index, {
                            ...field,
                            key: event.target.value,
                          }),
                        })
                      }
                      placeholder="title"
                      value={field.key}
                    />
                    <Input
                      aria-label="Rótulo do campo"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputFields: replaceAt(draft.inputFields, index, {
                            ...field,
                            label: event.target.value,
                          }),
                        })
                      }
                      placeholder="Título"
                      value={field.label}
                    />
                    <Select
                      onValueChange={(type) =>
                        setDraft({
                          ...draft,
                          inputFields: replaceAt(draft.inputFields, index, {
                            ...field,
                            type: type as RecordConnectorInputType,
                          }),
                        })
                      }
                      value={field.type}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text">Texto</SelectItem>
                        <SelectItem value="number">Número</SelectItem>
                        <SelectItem value="boolean">Sim/não</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      aria-label="Remover campo"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          inputFields: draft.inputFields.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 size={13} />
                    </Button>
                    <label className="flex items-center gap-2 text-xs sm:col-span-4">
                      <Checkbox
                        checked={field.required}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            inputFields: replaceAt(draft.inputFields, index, {
                              ...field,
                              required: checked === true,
                            }),
                          })
                        }
                      />
                      Obrigatório
                    </label>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 rounded-xl border border-border p-4">
                <SectionTitle title="Registro criado no Diretório" />
                <Field label="Tipo de registro">
                  <Select
                    onValueChange={(targetRecordTypeId) =>
                      setDraft({
                        ...draft,
                        targetRecordTypeId,
                        fieldMappings: [],
                      })
                    }
                    value={draft.targetRecordTypeId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecione o tipo de registro" />
                    </SelectTrigger>
                    <SelectContent>
                      {(directory?.recordTypes ?? [])
                        .filter((recordType) => !recordType.archivedAt)
                        .map((recordType) => (
                          <SelectItem
                            key={recordType.id}
                            value={recordType.id}
                          >
                            {recordType.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Caminho do nome">
                    <Input
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          recordNamePath: event.target.value,
                        })
                      }
                      placeholder="response.title"
                      value={draft.recordNamePath}
                    />
                  </Field>
                  <Field label="Caminho da descrição">
                    <Input
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          recordDescriptionPath: event.target.value,
                        })
                      }
                      placeholder="response.description"
                      value={draft.recordDescriptionPath}
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground">
                    Mapear resposta para campos personalizados
                  </span>
                  <Button
                    disabled={!draft.targetRecordTypeId}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        fieldMappings: [
                          ...draft.fieldMappings,
                          { fieldId: "", valuePath: "response." },
                        ],
                      })
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus size={12} /> Mapeamento
                  </Button>
                </div>
                {draft.fieldMappings.map((mapping, index) => (
                  <div
                    className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                    key={`${mapping.fieldId}:${index}`}
                  >
                    <Select
                      onValueChange={(fieldId) =>
                        setDraft({
                          ...draft,
                          fieldMappings: replaceAt(
                            draft.fieldMappings,
                            index,
                            { ...mapping, fieldId },
                          ),
                        })
                      }
                      value={mapping.fieldId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Campo do Diretório" />
                      </SelectTrigger>
                      <SelectContent>
                        {(directory?.fields ?? [])
                          .filter(
                            (field) =>
                              field.recordTypeId ===
                                draft.targetRecordTypeId &&
                              !field.archivedAt,
                          )
                          .map((field) => (
                            <SelectItem key={field.id} value={field.id}>
                              {field.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label="Caminho do valor"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          fieldMappings: replaceAt(
                            draft.fieldMappings,
                            index,
                            {
                              ...mapping,
                              valuePath: event.target.value,
                            },
                          ),
                        })
                      }
                      placeholder="response.url"
                      value={mapping.valuePath}
                    />
                    <Button
                      aria-label="Remover mapeamento"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          fieldMappings: draft.fieldMappings.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-relaxed text-amber-950">
                <Braces className="mt-0.5 shrink-0" size={16} />
                A chamada cria dados no sistema externo. O ThreadMark registra a
                execução, nunca expõe o token na resposta e não envia mensagens
                pelo WhatsApp.
              </div>
            </div>

            <DialogFooter>
              <Button
                disabled={saving}
                onClick={() => setDraft(null)}
                type="button"
                variant="outline"
              >
                Cancelar
              </Button>
              <Button
                disabled={
                  saving ||
                  !draft.name.trim() ||
                  !draft.urlTemplate.trim() ||
                  !draft.targetRecordTypeId ||
                  !draft.recordNamePath.trim()
                }
                onClick={() => void save()}
                type="button"
                variant="default"
              >
                {saving ? (
                  <LoaderCircle className="animate-spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                Salvar conector
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="text-sm font-semibold text-foreground">{title}</h3>;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground">
      {label}
      {children}
    </label>
  );
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function draftFromConnector(connector: RecordConnectorDto): Draft {
  return {
    id: connector.id,
    name: connector.name,
    description: connector.description ?? "",
    enabled: connector.enabled,
    method: connector.method,
    urlTemplate: connector.urlTemplate,
    headersTemplate: connector.headersTemplate,
    bodyTemplate: connector.bodyTemplate,
    token: "",
    targetRecordTypeId: connector.targetRecordTypeId,
    recordNamePath: connector.recordNamePath,
    recordDescriptionPath: connector.recordDescriptionPath ?? "",
    inputFields: connector.inputFields,
    fieldMappings: connector.fieldMappings,
  };
}
