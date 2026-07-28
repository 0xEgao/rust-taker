import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getLogs } from "../../api/commands";
import type { LogLine } from "../../api/types";
import { Card, LogViewer } from "../../components/ui/display";
import { SegmentedToggle } from "../../components/ui/inputs";
import { logLevel, type LogLevel } from "../../lib/wallet-format";

// debug.log itself has no size cap; this tail is capped since there's no pagination here.
const MAX_LINES = 100;

type LevelFilter = "all" | LogLevel;

export function LogsPage() {
  const navigate = useNavigate();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");

  // Covers the initial load too — autoRefresh defaults to true, so this fires immediately on mount.
  useEffect(() => {
    if (!autoRefresh) return;
    const load = () => void getLogs(MAX_LINES).then(setLines);
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  const filtered = useMemo(
    () => (levelFilter === "all" ? lines : lines.filter((l) => logLevel(l.line) === levelFilter)),
    [lines, levelFilter],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 pb-8 pt-2">
      <div className="flex shrink-0 items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/settings")}
            title="Back to Settings"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-control border border-line text-muted transition-colors hover:border-line-strong hover:text-foreground"
          >
            <ArrowLeft size={16} strokeWidth={1.8} />
          </button>
          <div>
            <h1 className="font-header text-[26px] font-bold text-foreground">Logs</h1>
            <p className="mt-1 text-[13.5px] text-muted">
              Last {MAX_LINES} lines of this session's debug log — see debug.log for the full history.
            </p>
          </div>
        </div>
        <Card className="flex items-center gap-2.5 border-line-strong px-3 py-2">
          <SegmentedToggle
            groupId="logs-level-filter"
            value={levelFilter}
            onChange={setLevelFilter}
            options={[
              { value: "all", label: "All" },
              { value: "info", label: "Info" },
              { value: "warn", label: "Warn" },
              { value: "error", label: "Error" },
              { value: "debug", label: "Debug" },
            ]}
          />
          <SegmentedToggle
            groupId="logs-autorefresh"
            value={autoRefresh ? "on" : "off"}
            onChange={(v) => setAutoRefresh(v === "on")}
            options={[
              { value: "on", label: "Auto-refresh" },
              { value: "off", label: "Paused" },
            ]}
          />
        </Card>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col border-line-strong">
        <LogViewer lines={filtered} emptyMessage={lines.length === 0 ? "No log lines yet." : "No log lines match this filter."} />
      </Card>
    </div>
  );
}
