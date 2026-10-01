import { useEffect, useState } from "react";
import type { LogLine } from "../../api/types";
import { Checklist, type CheckState } from "../ui/Checklist";

const POLL_MS = 2000;
const UTXO_RE = /CachedUtxos: (\d+) -> (\d+)/;

/**
 * A restore, read off the crate's own log lines for it. The restore only starts writing once the
 * backup has been read and its password accepted, so the first line ticks both; it then connects
 * to the chain server, "Sync Started" begins the address scan, each "[UTXO_STATE]" line reports
 * coins found so far, and "Synced & Saved" ends it. Nothing is advanced on a timer.
 */
export function RestoreProgress({
  load,
  finalStep,
  note,
}: {
  load: () => Promise<LogLine[]>;
  /** What happens after the scan, if the page shows it here. */
  finalStep?: string;
  note: string;
}) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const poll = () =>
      void load()
        .then((next) => live && setLines(next.map((l) => l.line)))
        .catch(() => {});
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  const started = lines.length > 0;
  const scanning = lines.some((l) => l.includes("Sync Started"));
  const done = lines.some((l) => l.includes("Synced & Saved"));
  const coins = lines.reduce((found, l) => Number(l.match(UTXO_RE)?.[2] ?? found), 0);
  const state = (begun: boolean, finished: boolean): CheckState =>
    finished ? "passed" : begun ? "running" : "idle";

  return (
    <div className="flex flex-col gap-4">
      <Checklist
        steps={[
          { label: "Reading the backup file", state: state(true, started) },
          { label: "Unlocking it with the password", state: state(true, started) },
          { label: "Connecting to the chain server", state: state(started, scanning) },
          {
            label: `Scanning old addresses (several minutes)${coins > 0 ? ` · ${coins} coin${coins === 1 ? "" : "s"} found` : ""}`,
            state: state(scanning, done),
          },
          ...(finalStep ? [{ label: finalStep, state: state(done, false) }] : []),
        ]}
      />
      <p className="text-[11.5px] leading-5 text-subtle">{note}</p>
    </div>
  );
}
