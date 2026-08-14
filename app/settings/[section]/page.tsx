import { ThreadmarkPage } from "../../threadmark-page";

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  return (
    <ThreadmarkPage initialPath={`/settings/${encodeURIComponent(section)}`} />
  );
}
