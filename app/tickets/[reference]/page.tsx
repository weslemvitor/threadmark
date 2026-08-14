import { ThreadmarkPage } from "../../threadmark-page";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  return (
    <ThreadmarkPage initialPath={`/tickets/${encodeURIComponent(reference)}`} />
  );
}
