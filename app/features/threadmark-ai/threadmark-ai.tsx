"use client";

import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  History,
  LoaderCircle,
  Maximize2,
  MessageCircleMore,
  Minimize2,
  Paperclip,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { Checkbox } from "@/app/components/ui/checkbox";
import { Input } from "@/app/components/ui/input";
import { ScrollArea } from "@/app/components/ui/scroll-area";
import { Textarea } from "@/app/components/ui/textarea";
import { InlineImageAttachment } from "@/app/components/shared";
import {
  addThreadmarkAiMessage,
  cancelThreadmarkAiTurn,
  createThreadmarkAiThread,
  getThreadmarkAiThread,
  listThreadmarkAiThreads,
  openCurrentThreadmarkAiThread,
  retryThreadmarkAiTurn,
} from "@/app/lib/api";
import { formatMessageTime } from "@/app/lib/format";
import { cn } from "@/app/lib/utils";
import type {
  ThreadmarkAiContextDto,
  ThreadmarkAiImageUploadInput,
  ThreadmarkAiThreadDto,
  ThreadmarkAiThreadListResponse,
} from "@/shared/contracts";
import {
  INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH,
  THREADMARK_AI_IMAGE_MAX_BYTES,
  THREADMARK_AI_IMAGE_MAX_COUNT,
  THREADMARK_AI_IMAGE_MAX_TOTAL_BYTES,
  THREADMARK_AI_IMAGE_MIME_TYPES,
} from "@/shared/contracts";

const ACTIVE_POLL_INTERVAL_MS = 1_500;
const IDLE_POLL_INTERVAL_MS = 8_000;

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
}

const SUPPORTED_IMAGE_TYPES = new Set<string>(THREADMARK_AI_IMAGE_MIME_TYPES);

async function imageUploadInput(image: PendingImage): Promise<ThreadmarkAiImageUploadInput> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("Não foi possível ler a imagem.")), { once: true });
    reader.readAsDataURL(image.file);
  });
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("Não foi possível preparar a imagem.");
  return {
    fileName: image.file.name,
    mimeType: image.file.type as ThreadmarkAiImageUploadInput["mimeType"],
    dataBase64: dataUrl.slice(separator + 1),
  };
}

function isRunning(thread: ThreadmarkAiThreadDto | null): boolean {
  return thread?.activeTurnState === "queued" || thread?.activeTurnState === "running";
}

function ThreadmarkAiMessage({
  message,
}: {
  message: ThreadmarkAiThreadDto["messages"][number];
}) {
  const assistant = message.role === "assistant";
  const [copied, setCopied] = useState(false);

  async function copyResponse() {
    if (!message.suggestedResponse) return;
    await navigator.clipboard.writeText(message.suggestedResponse);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }

  return (
    <article className={cn("flex items-start gap-2.5", !assistant && "flex-row-reverse")}>
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full",
          assistant ? "bg-primary/10 text-primary" : "bg-foreground text-background",
        )}
      >
        {assistant ? <Bot size={15} /> : <UserRound size={15} />}
      </span>
      <div
        className={cn(
          "min-w-0 max-w-[min(88%,42rem)] rounded-2xl border px-3.5 py-3 shadow-sm",
          assistant ? "border-border bg-card" : "border-primary/15 bg-primary/5",
        )}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <strong>{assistant ? "Threadmark AI" : "Você"}</strong>
          {message.phase ? (
            <Badge className="h-4 px-1.5 text-[10px]" variant="secondary">
              {message.phase === "needs_information"
                ? "Precisa de contexto"
                : message.phase === "conclusion" ? "Concluído" : "Analisando"}
            </Badge>
          ) : null}
          <time className="ml-auto text-muted-foreground" dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt)}
          </time>
        </div>
        {message.context?.label && !assistant ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Contexto: {message.context.label}
          </p>
        ) : null}
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
          {message.body}
        </p>

        {message.attachments.length ? (
          <div className="mt-3 grid gap-2">
            {message.attachments.map((attachment) => (
              <InlineImageAttachment
                attachment={{
                  ...attachment,
                  kind: "image",
                  available: true,
                  extractedText: null,
                  sha256: "",
                  transcription: null,
                }}
                key={attachment.id}
              />
            ))}
          </div>
        ) : null}

        {message.toolExecutions.length ? (
          <details className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium">
              <Wrench size={13} /> {message.toolExecutions.length} operação(ões) auditada(s)
            </summary>
            <div className="mt-2 grid gap-2">
              {message.toolExecutions.map((execution) => (
                <div className="rounded-md border bg-background p-2" key={execution.requestId}>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <strong className="break-words">{execution.toolName}</strong>
                    <Badge variant={execution.status === "success" ? "secondary" : "destructive"}>
                      {execution.status === "success" ? "Concluída" : "Falhou"}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {execution.summary}
                  </p>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {message.evidence.length ? (
          <details className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-emerald-900">
              <ShieldCheck size={13} /> {message.evidence.length} evidência(s)
            </summary>
            <ul className="mt-2 grid gap-1.5 text-xs text-emerald-950/80">
              {message.evidence.map((evidence, index) => (
                <li className="break-words" key={`${evidence.source}-${index}`}>
                  {evidence.summary}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {message.suggestedResponse ? (
          <section className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-primary">
              <Sparkles size={13} /> Sugestão de resposta
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
              {message.suggestedResponse}
            </p>
            <Button className="mt-2 gap-1.5" onClick={() => void copyResponse()} size="sm" variant="outline">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copiada" : "Copiar"}
            </Button>
          </section>
        ) : null}

        {message.nextAction ? (
          <section className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5">
            <strong className="text-xs text-amber-950">Próxima ação segura</strong>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-amber-900/80">
              {message.nextAction}
            </p>
          </section>
        ) : null}
      </div>
    </article>
  );
}

export function ThreadmarkAi({
  context,
}: {
  context: ThreadmarkAiContextDto | null;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [thread, setThread] = useState<ThreadmarkAiThreadDto | null>(null);
  const [threads, setThreads] = useState<ThreadmarkAiThreadListResponse["items"]>([]);
  const [body, setBody] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageAnalysisApproved, setImageAnalysisApproved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef<PendingImage[]>([]);
  const pendingMessageRef = useRef<{ body: string; id: string } | null>(null);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  const refreshList = useCallback(async () => {
    const response = await listThreadmarkAiThreads();
    setThreads(response.items);
  }, []);

  const openAssistant = useCallback(async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const current = thread ?? (await openCurrentThreadmarkAiThread(context));
      setThread(current);
      await refreshList();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Não foi possível abrir o Threadmark AI.");
    } finally {
      setLoading(false);
    }
  }, [context, refreshList, thread]);

  const refreshThread = useCallback(async () => {
    if (!thread) return;
    try {
      const refreshed = await getThreadmarkAiThread(thread.id);
      setThread(refreshed);
      setError(null);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Não foi possível atualizar a conversa.");
    }
  }, [thread]);

  useEffect(() => {
    if (!thread) return;
    const interval = window.setInterval(
      () => void refreshThread(),
      isRunning(thread) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [refreshThread, thread]);

  useEffect(() => {
    if (!open || historyOpen) return;
    const viewport = viewportRef.current?.querySelector<HTMLDivElement>("[data-slot='scroll-area-viewport']");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [historyOpen, open, thread?.messages.length, thread?.activeTurnState]);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  function selectImages(files: FileList | null) {
    if (!files?.length) return;
    const selected = [...files];
    if (images.length + selected.length > THREADMARK_AI_IMAGE_MAX_COUNT) {
      setError(`Você pode anexar no máximo ${THREADMARK_AI_IMAGE_MAX_COUNT} imagens.`);
      return;
    }
    if (selected.some((file) => !SUPPORTED_IMAGE_TYPES.has(file.type))) {
      setError("Use imagens JPEG, PNG, GIF ou WebP.");
      return;
    }
    if (selected.some((file) => file.size <= 0 || file.size > THREADMARK_AI_IMAGE_MAX_BYTES)) {
      setError("Cada imagem deve ter no máximo 10 MB.");
      return;
    }
    const totalBytes = [...images, ...selected.map((file) => ({ file }))]
      .reduce((total, image) => total + image.file.size, 0);
    if (totalBytes > THREADMARK_AI_IMAGE_MAX_TOTAL_BYTES) {
      setError("As imagens devem somar no máximo 25 MB por mensagem.");
      return;
    }
    setImages((current) => [
      ...current,
      ...selected.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
    setImageAnalysisApproved(false);
    setError(null);
  }

  function removeImage(imageId: string) {
    setImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      const remaining = current.filter((image) => image.id !== imageId);
      if (!remaining.length) setImageAnalysisApproved(false);
      return remaining;
    });
  }

  function clearImages() {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    setImageAnalysisApproved(false);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = body.trim();
    if (
      !thread ||
      !normalized ||
      sending ||
      isRunning(thread) ||
      (images.length > 0 && !imageAnalysisApproved)
    ) return;
    if (pendingMessageRef.current?.body !== normalized) {
      pendingMessageRef.current = { body: normalized, id: crypto.randomUUID() };
    }
    setSending(true);
    setError(null);
    try {
      const attachments = await Promise.all(images.map(imageUploadInput));
      const updated = await addThreadmarkAiMessage(
        thread.id,
        normalized,
        pendingMessageRef.current.id,
        context,
        attachments,
        imageAnalysisApproved,
      );
      setThread(updated);
      setBody("");
      clearImages();
      pendingMessageRef.current = null;
      await refreshList();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Não foi possível enviar a mensagem.");
    } finally {
      setSending(false);
    }
  }

  async function newConversation() {
    setLoading(true);
    setError(null);
    try {
      const created = await createThreadmarkAiThread(context);
      setThread(created);
      setHistoryOpen(false);
      await refreshList();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Não foi possível criar uma conversa.");
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    if (!thread || stopping) return;
    setStopping(true);
    try {
      setThread(await cancelThreadmarkAiTurn(thread.id));
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Não foi possível interromper o agente.");
    } finally {
      setStopping(false);
    }
  }

  const active = isRunning(thread);
  const latestTurn = thread?.turns.at(-1) ?? null;
  const failedTurn = latestTurn?.state === "failed" && !latestTurn.cancelledAt
    ? latestTurn
    : null;
  const contextLabel = context?.label ?? "Contexto global do workspace";
  const placeholder = useMemo(
    () => context?.ticketNumber
      ? `Pergunte sobre o ticket #${context.ticketNumber}, peça uma sugestão ou prepare uma ação…`
      : "Pergunte sobre conversas, tickets, regras de negócio ou prepare uma ação…",
    [context?.ticketNumber],
  );

  return (
    <>
      {!open || !expanded ? (
        <Button
          aria-label={open ? "Fechar Threadmark AI" : "Abrir Threadmark AI"}
          className="fixed right-5 bottom-5 z-[60] size-12 rounded-full shadow-lg"
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            void openAssistant();
          }}
          size="icon"
          title={open ? "Fechar Threadmark AI" : "Abrir Threadmark AI"}
        >
          {open ? <ChevronDown size={20} /> : <Sparkles size={19} />}
          {active ? <span className="absolute -top-0.5 -right-0.5 size-3 animate-pulse rounded-full border-2 border-background bg-emerald-500" /> : null}
        </Button>
      ) : null}

      {open ? (
        <Card
          aria-describedby="threadmark-ai-description"
          aria-labelledby="threadmark-ai-title"
          aria-modal="false"
          className={cn(
            "fixed z-50 flex min-h-0 flex-col gap-0 overflow-hidden rounded-2xl border border-border bg-card py-0 shadow-2xl transition-[width,height,inset] duration-200 ease-out motion-reduce:transition-none",
            expanded
              ? "inset-2 sm:inset-y-5 sm:right-5 sm:left-auto sm:w-[min(920px,calc(100vw-2.5rem))]"
              : "inset-x-2 top-2 bottom-20 sm:inset-x-auto sm:top-auto sm:right-5 sm:bottom-20 sm:h-[min(680px,calc(100dvh-6.25rem))] sm:w-[400px]",
          )}
          role="dialog"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            {historyOpen ? (
              <Button aria-label="Voltar à conversa" onClick={() => setHistoryOpen(false)} size="icon-sm" variant="ghost">
                <ArrowLeft size={15} />
              </Button>
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <Sparkles size={16} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold" id="threadmark-ai-title">
                Threadmark AI
                {active ? <span className="size-2 animate-pulse rounded-full bg-emerald-500" title="Agente trabalhando" /> : null}
              </h2>
              <p className="truncate text-xs text-muted-foreground" id="threadmark-ai-description">
                {historyOpen ? "Histórico persistido no SQLite" : contextLabel}
              </p>
            </div>
            <Button aria-label="Histórico de conversas" onClick={() => { setHistoryOpen((value) => !value); void refreshList(); }} size="icon-sm" title="Histórico" variant="ghost">
              <History size={15} />
            </Button>
            <Button aria-label="Nova conversa" onClick={() => void newConversation()} size="icon-sm" title="Nova conversa" variant="ghost">
              <Plus size={16} />
            </Button>
            <Button
              aria-label={expanded ? "Recolher Threadmark AI" : "Expandir Threadmark AI"}
              onClick={() => setExpanded((value) => !value)}
              size="icon-sm"
              title={expanded ? "Recolher janela" : "Expandir janela"}
              variant="ghost"
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </Button>
            <Button aria-label="Fechar Threadmark AI" onClick={() => setOpen(false)} size="icon-sm" title="Fechar" variant="ghost">
              <X size={16} />
            </Button>
          </header>

          {historyOpen ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-2 p-4">
                {threads.map((item) => (
                  <Button
                    className={cn(
                      "h-auto min-w-0 max-w-full justify-start overflow-hidden whitespace-normal rounded-xl border p-3 text-left transition-colors hover:bg-muted/50",
                      item.id === thread?.id && "border-primary/40 bg-primary/5",
                    )}
                    key={item.id}
                    onClick={() => {
                      setLoading(true);
                      void getThreadmarkAiThread(item.id)
                        .then((selected) => { setThread(selected); setHistoryOpen(false); })
                        .catch((currentError: unknown) => setError(currentError instanceof Error ? currentError.message : "Não foi possível abrir a conversa."))
                        .finally(() => setLoading(false));
                    }}
                    size="unstyled"
                    type="button"
                    variant="unstyled"
                  >
                    <div className="w-0 min-w-0 flex-1 overflow-hidden">
                      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                        <strong className="block min-w-0 flex-1 truncate text-sm" title={item.title}>{item.title}</strong>
                        {item.activeTurnState === "queued" || item.activeTurnState === "running" ? (
                          <Badge variant="secondary">Em execução</Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">Atualizada {formatMessageTime(item.updatedAt)}</p>
                    </div>
                  </Button>
                ))}
                {!threads.length && !loading ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">Nenhuma conversa criada.</p>
                ) : null}
              </div>
            </ScrollArea>
          ) : (
            <>
              <ScrollArea className="min-h-0 flex-1" ref={viewportRef}>
                <div className="grid gap-4 p-4">
                  {loading && !thread ? (
                    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                      <LoaderCircle className="animate-spin" size={16} /> Preparando o contexto…
                    </div>
                  ) : null}
                  {thread && !thread.messages.length ? (
                    <section className="mx-auto max-w-sm py-12 text-center">
                      <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                        <MessageCircleMore size={20} />
                      </span>
                      <h3 className="mt-3 text-sm font-semibold">Como posso ajudar?</h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Posso investigar tickets, consultar as ferramentas autorizadas, sugerir respostas e preparar ações para sua aprovação.
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {["Resuma o contexto atual", "Sugira uma resposta", "O que precisa ser investigado?"].map((suggestion) => (
                          <Button key={suggestion} onClick={() => setBody(suggestion)} size="sm" variant="outline">
                            {suggestion}
                          </Button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {thread?.messages.map((message) => (
                    <ThreadmarkAiMessage key={message.id} message={message} />
                  ))}
                  {active ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="grid size-8 place-items-center rounded-full bg-primary/10 text-primary">
                        <LoaderCircle className="animate-spin" size={14} />
                      </span>
                      O agente continua trabalhando em segundo plano…
                    </div>
                  ) : null}
                  {failedTurn ? (
                    <section className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
                      <strong className="text-xs">O turno encontrou um bloqueio</strong>
                      <p className="mt-1 break-words text-xs leading-relaxed text-amber-900/80">
                        {failedTurn.error ?? "Não foi possível concluir após as tentativas automáticas."}
                      </p>
                      <Button
                        className="mt-2"
                        disabled={retrying}
                        onClick={() => {
                          if (!thread || retrying) return;
                          setRetrying(true);
                          setError(null);
                          void retryThreadmarkAiTurn(thread.id)
                            .then(setThread)
                            .catch((currentError: unknown) => setError(
                              currentError instanceof Error
                                ? currentError.message
                                : "Não foi possível tentar novamente.",
                            ))
                            .finally(() => setRetrying(false));
                        }}
                        size="sm"
                        variant="outline"
                      >
                        {retrying ? <LoaderCircle className="animate-spin" size={14} /> : null}
                        Tentar novamente
                      </Button>
                    </section>
                  ) : null}
                </div>
              </ScrollArea>

              <form className="border-t border-border bg-card p-4" onSubmit={(event) => void submit(event)}>
                {error ? (
                  <p className="mb-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                ) : null}
                <Input
                  accept={THREADMARK_AI_IMAGE_MIME_TYPES.join(",")}
                  className="sr-only"
                  multiple
                  onChange={(event) => {
                    selectImages(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  ref={imageInputRef}
                  type="file"
                />
                {images.length ? (
                  <div className="mb-2 grid grid-cols-3 gap-2">
                    {images.map((image) => (
                      <figure className="relative min-w-0 overflow-hidden rounded-lg border bg-muted" key={image.id}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- Prévia local criada pelo navegador. */}
                        <img alt={image.file.name} className="h-20 w-full object-cover" src={image.previewUrl} />
                        <figcaption className="truncate px-2 py-1 text-[10px]" title={image.file.name}>
                          {image.file.name}
                        </figcaption>
                        <Button
                          aria-label={`Remover ${image.file.name}`}
                          className="absolute top-1 right-1 bg-background/90 shadow-sm"
                          onClick={() => removeImage(image.id)}
                          size="icon-xs"
                          title="Remover imagem"
                          type="button"
                          variant="outline"
                        >
                          <X size={12} />
                        </Button>
                      </figure>
                    ))}
                  </div>
                ) : null}
                <Textarea
                  aria-label="Mensagem para o Threadmark AI"
                  className="min-h-20 resize-none"
                  disabled={!thread || active || sending}
                  maxLength={INVESTIGATION_THREAD_MESSAGE_MAX_LENGTH}
                  onChange={(event) => setBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={placeholder}
                  value={body}
                />
                {images.length ? (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground" htmlFor="threadmark-ai-image-consent">
                    <Checkbox
                      checked={imageAnalysisApproved}
                      id="threadmark-ai-image-consent"
                      onCheckedChange={(checked) => setImageAnalysisApproved(checked === true)}
                    />
                    <span>
                      Autorizo o processamento destas imagens pelo provedor de IA configurado no Threadmark.
                    </span>
                  </label>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Button
                      aria-label="Anexar imagens"
                      disabled={!thread || active || sending || images.length >= THREADMARK_AI_IMAGE_MAX_COUNT}
                      onClick={() => imageInputRef.current?.click()}
                      size="sm"
                      title="Anexar imagens"
                      type="button"
                      variant="outline"
                    >
                      <Paperclip size={13} />
                      Imagens
                    </Button>
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      Nada é enviado ao WhatsApp.
                    </span>
                  </div>
                  {active ? (
                    <Button disabled={stopping} onClick={() => void stop()} size="sm" type="button" variant="outline">
                      {stopping ? <LoaderCircle className="animate-spin" size={14} /> : <Square size={13} />}
                      Parar
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        !thread ||
                        !body.trim() ||
                        sending ||
                        (images.length > 0 && !imageAnalysisApproved)
                      }
                      size="sm"
                      type="submit"
                    >
                      {sending ? <LoaderCircle className="animate-spin" size={14} /> : <ArrowUp size={14} />}
                      Enviar
                    </Button>
                  )}
                </div>
              </form>
            </>
          )}
        </Card>
      ) : null}
    </>
  );
}
