import { AlertTriangle, Check, Copy, Eye } from "lucide-react";
import { useState } from "react";
import { Card, Notice } from "../ui/display";
import { Button } from "../ui/inputs";
import { copyText } from "../../lib/clipboard";

/**
 * Shown once, right after a wallet or router is created. The crate hands the phrase out a single
 * time, so nothing here is skippable: Continue waits for the words to be revealed and the user to
 * say they wrote them down.
 */
export function RecoveryPhraseScreen({
  words,
  subject,
  onSaved,
}: {
  words: string;
  subject: "wallet" | "router";
  onSaved: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [written, setWritten] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const list = words.split(" ");

  async function copy() {
    if (!(await copyText(words))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function finish() {
    setSaving(true);
    try {
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-8 py-10">
      <Card className="flex w-full max-w-lg shrink-0 flex-col gap-5 border-line-strong p-7">
        <div>
          <h1 className="font-header text-[19px] font-bold text-foreground">
            Save your recovery phrase
          </h1>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            These {list.length} words are the only way to restore this {subject} if this device is
            lost. Write them down on paper, in order.
          </p>
        </div>

        <div className="relative">
          <ol
            className={`grid grid-cols-3 gap-2 font-mono text-[12.5px] max-[520px]:grid-cols-2 ${
              revealed ? "" : "pointer-events-none select-none blur-md"
            }`}
            aria-hidden={!revealed}
          >
            {list.map((word, i) => (
              <li
                key={i}
                className="flex items-baseline gap-2 rounded-control border border-line bg-surface-raised px-3 py-2"
              >
                <span className="w-5 text-right text-[10.5px] text-subtle">{i + 1}</span>
                <span className="text-foreground">{word}</span>
              </li>
            ))}
          </ol>
          {!revealed && (
            <div className="absolute inset-0 grid place-items-center">
              <Button variant="secondary" size="sm" onClick={() => setRevealed(true)}>
                <Eye size={14} strokeWidth={2} /> Reveal words
              </Button>
            </div>
          )}
        </div>

        {revealed && (
          <div>
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
              {copied ? "Copied" : "Copy words"}
            </Button>
          </div>
        )}

        <Notice tone="warning" icon={<AlertTriangle size={18} strokeWidth={2} />}>
          <p className="font-semibold text-warning">
            Portal shows these words once. They cannot be shown again after you continue.
          </p>
          <p className="mt-1 text-muted">
            Anyone with them can take the funds. Never type them into a website or share them.
          </p>
        </Notice>

        <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-muted">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={written}
            disabled={!revealed}
            onChange={(e) => setWritten(e.target.checked)}
          />
          I have written these words down.
        </label>

        <Button disabled={!revealed || !written} loading={saving} onClick={() => void finish()}>
          Continue
        </Button>
      </Card>
    </div>
  );
}
