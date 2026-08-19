import { Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { importDashboardMakers, listDashboardImports } from "../../api/commands";
import { Button } from "../../components/ui/inputs";
import { useToastStore } from "../../store/toast";

const DISMISSED_KEY = "maker.dashboardImportDismissed";

function loadDismissed(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Offers the Maker Dashboard's registrations for an explicit import. Adopting them on load
 * instead is what made deleted makers reappear: the registry is the only record of what the
 * user curated, so an absent or reset one cannot be read as "nothing has been imported yet".
 * Dismissal lives in `localStorage` rather than the registry — losing it re-offers an import,
 * never performs one.
 */
export function DashboardImport({ onImported }: { onImported: () => void }) {
  const [available, setAvailable] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const pushToast = useToastStore((state) => state.push);

  useEffect(() => {
    void (async () => {
      try {
        const dismissed = loadDismissed();
        const found = await listDashboardImports();
        setAvailable(found.map((s) => s.makerId).filter((id) => !dismissed.includes(id)));
      } catch {
        // A dashboard that isn't installed, or an encrypted store, is the normal case.
        setAvailable([]);
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...loadDismissed(), ...available]));
    setAvailable([]);
  }, [available]);

  async function runImport() {
    setImporting(true);
    try {
      const imported = await importDashboardMakers(available);
      setAvailable([]);
      pushToast("success", `Imported ${imported.length} maker${imported.length === 1 ? "" : "s"}.`);
      onImported();
    } catch (error) {
      pushToast("error", (error as { message?: string })?.message ?? "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  if (available.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-line-strong bg-surface-raised/45 px-4 py-3.5 text-left">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-foreground">
          {available.length} registration{available.length === 1 ? "" : "s"} found in Maker Dashboard
        </p>
        <p className="mt-1 truncate font-mono text-[11px] text-subtle">{available.join(", ")}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" loading={importing} onClick={() => void runImport()}>
          <Download size={14} strokeWidth={1.8} />
          Import
        </Button>
        <Button variant="ghost" size="sm" className="px-2" onClick={dismiss} aria-label="Dismiss">
          <X size={14} strokeWidth={1.8} />
        </Button>
      </div>
    </div>
  );
}
