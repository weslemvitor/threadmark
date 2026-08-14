"use client";

import {
  AlertCircle,
  AudioLines,
  CheckCircle2,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { API_URL } from "@/app/lib/api";
import { formatBytes } from "@/app/lib/format";
import {
  queueAudioTranscription,
  retryAudioTranscription,
} from "@/app/lib/settings";
import { cn } from "@/app/lib/utils";
import type {
  AttachmentDto,
  AudioTranscriptionDto,
  AudioTranscriptionStatus,
} from "@/shared/contracts";

interface OptimisticTranscription {
  basedOnUpdatedAt: string | null;
  value: AudioTranscriptionDto;
}

export function AudioAttachment({
  attachment,
  className,
}: {
  attachment: AttachmentDto;
  className?: string;
}) {
  const [optimisticTranscription, setOptimisticTranscription] =
    useState<OptimisticTranscription | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const sourceHasAdvanced = Boolean(
    optimisticTranscription &&
      (attachment.transcription?.updatedAt ?? null) !==
        optimisticTranscription.basedOnUpdatedAt,
  );
  const transcription = sourceHasAdvanced
    ? attachment.transcription
    : optimisticTranscription?.value ?? attachment.transcription;
  const href = attachment.available && attachment.url
    ? attachment.url.startsWith("http")
      ? attachment.url
      : `${API_URL}${attachment.url}`
    : null;

  async function retry(): Promise<void> {
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await retryAudioTranscription(attachment.id);
      if (transcription) {
        setOptimisticTranscription({
          basedOnUpdatedAt: attachment.transcription?.updatedAt ?? null,
          value: {
            ...transcription,
            status: "queued",
            error: null,
            updatedAt: new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Não foi possível repetir a transcrição.");
    } finally {
      setSubmitting(false);
    }
  }

  async function transcribe(): Promise<void> {
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await queueAudioTranscription(attachment.id);
      setOptimisticTranscription({
        basedOnUpdatedAt: attachment.transcription?.updatedAt ?? null,
        value: {
          status: "queued",
          text: null,
          language: "pt",
          confidence: null,
          modelId: "",
          error: null,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Não foi possível transcrever este áudio.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-background/80", className)}>
      <div className="flex min-w-0 items-center gap-2 p-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <AudioLines size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-medium text-foreground">
            {attachment.fileName || "Áudio do WhatsApp"}
          </strong>
          <small className="mt-0.5 block truncate text-xs text-muted-foreground">
            {attachment.mimeType || "Áudio"}
            {attachment.sizeBytes ? ` · ${formatBytes(attachment.sizeBytes)}` : ""}
          </small>
        </span>
        <TranscriptionBadge status={transcription?.status} />
      </div>

      {href ? (
        <div className="border-t border-border px-2.5 py-2">
          <audio className="block h-9 w-full max-w-full" controls preload="metadata" src={href}>
            Seu navegador não consegue reproduzir este áudio.
          </audio>
        </div>
      ) : (
        <p className="m-0 border-t border-border px-2.5 py-2 text-xs text-muted-foreground">
          Arquivo de áudio não recuperado.
        </p>
      )}

      {!transcription && attachment.available ? (
        <div className="border-t border-border p-2.5">
          <Button className="w-full" disabled={submitting} onClick={() => void transcribe()} size="sm" type="button" variant="outline">
            {submitting ? <LoaderCircle className="animate-spin" size={13} /> : <AudioLines size={13} />}
            {submitting ? "Adicionando à fila" : "Transcrever"}
          </Button>
          {submissionError ? (
            <p className="mt-2 mb-0 break-words text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]" role="alert">
              {submissionError}
            </p>
          ) : null}
        </div>
      ) : null}

      {transcription ? (
        <div className="min-w-0 border-t border-border bg-muted/35 px-2.5 py-2">
          {transcription.text ? (
            <>
              <strong className="text-xs font-medium text-foreground">
                {transcription.status === "review" ? "Transcrição para revisão" : "Transcrição"}
              </strong>
              <p className="mt-1 mb-0 min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {transcription.text}
              </p>
            </>
          ) : (
            <p className="m-0 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {transcriptionMessage(transcription.status, transcription.error)}
            </p>
          )}
          {transcription.status === "failed" || transcription.status === "review" ? (
            <Button className="mt-2" disabled={submitting} onClick={() => void retry()} size="sm" type="button" variant="outline">
              {submitting ? <LoaderCircle className="animate-spin" size={13} /> : <RotateCcw size={13} />}
              Tentar novamente
            </Button>
          ) : null}
          {submissionError ? (
            <p className="mt-2 mb-0 break-words text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]" role="alert">
              {submissionError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TranscriptionBadge({ status }: { status?: AudioTranscriptionStatus }) {
  if (!status) return null;
  if (status === "completed") return <Badge className="shrink-0 gap-1 border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline"><CheckCircle2 size={11} /> Transcrito</Badge>;
  if (status === "failed") return <Badge className="shrink-0 gap-1" variant="destructive"><AlertCircle size={11} /> Falhou</Badge>;
  if (status === "review") return <Badge className="shrink-0 gap-1 border-amber-200 bg-amber-50 text-amber-700" variant="outline"><AlertCircle size={11} /> Revisar</Badge>;
  return <Badge className="shrink-0 gap-1" variant="secondary"><LoaderCircle className={status === "processing" ? "animate-spin" : undefined} size={11} /> {status === "processing" ? "Transcrevendo" : "Na fila"}</Badge>;
}

function transcriptionMessage(status: AudioTranscriptionStatus, error?: string | null): string {
  if (status === "queued") return "Aguardando o processamento local.";
  if (status === "processing") return "O modelo local está transcrevendo este áudio.";
  if (status === "failed") return error || "Não foi possível transcrever este áudio.";
  if (status === "review") return error || "A transcrição precisa de revisão humana antes de alimentar a IA.";
  return "Transcrição concluída.";
}
