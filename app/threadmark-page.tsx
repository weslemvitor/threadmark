import { AppAccessGate } from "./features/access";
import { SupportApp } from "./support-app";

export function ThreadmarkPage({ initialPath }: { initialPath: string }) {
  return (
    <AppAccessGate>
      <SupportApp initialPath={initialPath} />
    </AppAccessGate>
  );
}
