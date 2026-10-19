import type { ChannelAttachment } from "@/shared/channels";

export function ExternalChannelAttachments({attachments}: {attachments?:ChannelAttachment[]}) {
  if(!attachments?.length)return null;
  return <ul className="mt-2 grid gap-2">{attachments.map(attachment=><li key={attachment.id}><a className="block break-words rounded-lg border border-border bg-background p-2 text-sm text-primary underline underline-offset-4" href={attachment.url} target="_blank" rel="noopener noreferrer">{attachment.name || "Abrir anexo na origem"}</a></li>)}</ul>;
}
