import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../../api/types";
import { logLevel, type LogLevel } from "../../lib/wallet-format";
import { Card, LogViewer, SkeletonLines } from "../ui/display";
import { SegmentedToggle } from "../ui/inputs";

// The most the backend tails in one call. Debug lines outnumber the rest many times over, so a
// shorter tail would leave the Info view nearly empty.
const MAX_LINES = 1000;
const REFRESH_MS = 3000;

type Threshold = Exclude<LogLevel, "other">;
const RANK: Record<Threshold, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * One log tail with a level threshold: each level shows itself and everything more severe.
 * Shared by the wallet's Logs page and a router's Logs tab so both read the same way.
 */
export function LogPanel({
  title,
  load,
  className = "",
}: {
  title: string;
  load: (lines: number) => Promise<LogLine[]>;
  className?: string;
}) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<Threshold>("info");
  const [autoRefresh, setAutoRefresh] = useState(true);

  // The source whose answers may still be shown: a slow read for the previous one must not land
  // after the switch.
  const current = useRef(load);
  current.current = load;
  const fetchLines = useCallback(
    () =>
      void load(MAX_LINES)
        .then((next) => {
          if (current.current !== load) return;
          setLines(next);
          setError(null);
        })
        .catch((e) => {
          if (current.current !== load) return;
          setError((e as { message?: string })?.message ?? "Could not read the log.");
        }),
    [load],
  );

  // A new source — another router — replaces what is shown even while refresh is paused, or its
  // heading would sit over the previous router's lines.
  useEffect(() => {
    setLines(null);
    setError(null);
    fetchLines();
  }, [fetchLines]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchLines, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchLines, autoRefresh]);

  // A line with no level of its own — a wrapped message, a panic's backtrace — belongs to the
  // record above it, so it is shown and hidden with that record. The tail can open mid-record,
  // with that record's header cut off; those leading lines are only shown under Debug, since
  // what they belong to is unknown.
  const leveled = useMemo(() => {
    let current: Threshold = "debug";
    return (lines ?? []).map((line) => {
      const level = logLevel(line.line);
      if (level !== "other") current = level;
      return { line, level: current };
    });
  }, [lines]);

  const visibleAt = (t: Threshold) => leveled.filter((l) => RANK[l.level] <= RANK[t]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(RANK) as Threshold[]).map((t) => [t, visibleAt(t).length]),
      ) as Record<Threshold, number>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leveled],
  );
  const filtered = useMemo(
    () => visibleAt(threshold).map((l) => l.line),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leveled, threshold],
  );

  const count = (n: number) => <span className="font-mono text-[9px] opacity-60">{n}</span>;

  return (
    <Card className={`flex min-h-0 flex-col border-line-strong ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="font-header text-[14px] font-bold">{title}</h2>
          <span className="text-[10px] text-subtle">
            Latest {MAX_LINES} lines · newest first · refreshes every {REFRESH_MS / 1000} seconds
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedToggle
            groupId={`log-level-${title}`}
            subdued
            value={threshold}
            onChange={setThreshold}
            options={[
              { value: "error", label: "Error", suffix: count(counts.error) },
              { value: "warn", label: "Warn", suffix: count(counts.warn) },
              { value: "info", label: "Info", suffix: count(counts.info) },
              { value: "debug", label: "Debug", suffix: count(counts.debug) },
            ]}
          />
          <SegmentedToggle
            groupId={`log-refresh-${title}`}
            subdued
            value={autoRefresh ? "on" : "off"}
            onChange={(v) => setAutoRefresh(v === "on")}
            options={[
              { value: "on", label: "Auto-refresh" },
              { value: "off", label: "Paused" },
            ]}
          />
        </div>
      </div>
      {lines === null && error !== null ? (
        <p className="py-6 text-center text-[13px] text-danger">{error}</p>
      ) : lines === null ? (
        <SkeletonLines count={10} />
      ) : (
        <LogViewer
          lines={filtered}
          emptyMessage={
            lines.length === 0
              ? "No log lines yet."
              : `No ${threshold} log entries in the latest ${MAX_LINES} lines.`
          }
        />
      )}
    </Card>
  );
}
