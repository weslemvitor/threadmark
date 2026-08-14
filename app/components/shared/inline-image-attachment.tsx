"use client";

import { AlertCircle, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useState } from "react";

import type { AttachmentDto } from "@/shared/contracts";
import { API_URL } from "@/app/lib/api";
import { formatBytes } from "@/app/lib/format";

function attachmentSource(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return `${API_URL}${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

export function isImageAttachment(attachment: AttachmentDto): boolean {
  return (
    attachment.kind === "image" ||
    attachment.mimeType.toLowerCase().startsWith("image/")
  );
}

export function InlineImageAttachment({
  attachment,
}: {
  attachment: AttachmentDto;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const source = attachment.available
    ? attachmentSource(attachment.url)
    : null;
  const label = attachment.fileName?.trim() || "Imagem da conversa";
  const metadata = [
    attachment.mimeType || "imagem",
    attachment.sizeBytes ? formatBytes(attachment.sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!source || previewFailed) {
    return (
      <div className="flex w-full max-w-[460px] min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 p-2 text-muted-foreground">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-700" aria-hidden="true">
          {source ? <AlertCircle size={17} /> : <ImageIcon size={17} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-xs text-foreground">{label}</strong>
          <small className="mt-1 text-xs text-muted-foreground">
            {source ? "Prévia indisponível" : "Imagem não recuperada"}
            {metadata ? ` · ${metadata}` : ""}
          </small>
        </span>
        {source ? (
          <a className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline" href={source} rel="noreferrer" target="_blank">
            Abrir original <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <figure className="m-0 w-full max-w-[460px] overflow-hidden rounded-xl border border-border bg-muted shadow-sm">
      <div className="flex min-h-28 max-h-[min(420px,55vh)] items-center justify-center overflow-hidden bg-muted/60 max-[760px]:max-h-[min(360px,52vh)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- A API local não fornece dimensões e exige URL dinâmica. */}
        <img
          className="block h-auto max-h-[min(420px,55vh)] w-auto max-w-full object-contain max-[760px]:max-h-[min(360px,52vh)]"
          alt={label}
          decoding="async"
          loading="lazy"
          onError={() => setPreviewFailed(true)}
          src={source}
        />
      </div>
      <figcaption className="flex min-h-10 min-w-0 items-center gap-2 border-t border-border bg-card/95 px-2.5 py-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-xs font-medium text-foreground" title={label}>{label}</strong>
          <small className="mt-0.5 text-xs text-muted-foreground">{metadata}</small>
        </span>
        <a
          aria-label={`Abrir ${label} em tamanho original`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
          href={source}
          rel="noreferrer"
          target="_blank"
        >
          Original <ExternalLink size={11} />
        </a>
      </figcaption>
    </figure>
  );
}
