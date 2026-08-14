import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import type { LogLine } from "../../api/types";
import { explorerTxUrl, LOG_LEVEL_TONE, logLevel } from "../../lib/wallet-format";
import { walletIdentity } from "../../lib/wallet-identity";

// Blur lives on its own layer, not this rounded/overflow-hidden div, to dodge a WebKit corner-seam
// bug; `isolate` keeps descendants' negative z-index glows contained instead of escaping the card.
export function Card({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`relative isolate overflow-hidden rounded-card border bg-surface-raised/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] ${className}`}
      {...props}
    >
      <div className="pointer-events-none absolute inset-0 -z-20 backdrop-blur-2xl" />
      <div className="pointer-events-none absolute -left-10 -top-14 -z-10 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-14 -right-10 -z-10 h-48 w-48 rounded-full bg-white/[0.07] blur-3xl" />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-20 bg-gradient-to-b from-white/[0.08] to-transparent" />
      {children}
    </div>
  );
}

interface ModalProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function Modal({ title, children, footer, onClose }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-card border border-line-strong bg-surface p-6">
        <h3 className="font-header text-[15px] font-bold text-foreground">{title}</h3>
        <div className="mt-4 flex flex-col gap-3">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

export function IconBadge({
  children,
  variant = "solid",
}: {
  children: ReactNode;
  variant?: "solid" | "outline";
}) {
  if (variant === "outline") {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-surface-raised text-primary">
        {children}
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary font-bold text-on-primary">
      {children}
    </div>
  );
}

const cardButtonBase =
  "flex flex-col items-center gap-3 rounded-card border px-6 py-8 text-center transition-colors duration-200";

export function SelectableCard({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cardButtonBase} ${
        selected ? "border-primary bg-primary/5" : "border-line hover:border-line-strong hover:bg-white/[0.02]"
      }`}
    >
      <IconBadge variant="outline">{icon}</IconBadge>
      <span className="text-[15px] font-semibold text-foreground">{title}</span>
      <span className="text-[12.5px] text-muted">{description}</span>
    </button>
  );
}

export function SatsAmount({ sats, className = "" }: { sats: number; className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`}>
      <span>{Math.round(sats).toLocaleString()}</span>
      <SatsGlyph className="text-subtle" />
    </span>
  );
}

/** Stylized sats glyph (a bar with 3 ticks), mirroring the old app's .cs-sats-symbol. */
export function SatsGlyph({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="satoshis"
      className={`relative inline-block h-[1em] w-[0.72em] align-middle text-[0.72em] ${className}`}
    >
      <span className="absolute left-1/2 top-0 h-[0.14em] w-[0.14em] -translate-x-1/2 rounded-[1px] bg-current" />
      <span className="absolute left-1/2 bottom-0 h-[0.14em] w-[0.14em] -translate-x-1/2 rounded-[1px] bg-current" />
      <span className="absolute left-[0.04em] right-[0.04em] top-[0.245em] h-[0.1em] rounded-[1px] bg-current" />
      <span className="absolute left-[0.04em] right-[0.04em] top-[0.45em] h-[0.1em] rounded-[1px] bg-current" />
      <span className="absolute left-[0.04em] right-[0.04em] top-[0.655em] h-[0.1em] rounded-[1px] bg-current" />
    </span>
  );
}

/** Collapsed-by-default section, e.g. raw proof dumps or verbose logs nobody needs by default. */
export function Disclosure({
  label,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** Notified on every toggle — lets a parent gate work (e.g. a poll) on visibility. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  function toggle() {
    setOpen((o) => {
      onOpenChange?.(!o);
      return !o;
    });
  }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center justify-between gap-2 rounded-control border border-line bg-surface-raised px-3.5 py-2.5 text-[12px] font-medium text-muted transition-colors hover:text-foreground"
      >
        <span>{label}</span>
        <ChevronDown size={15} strokeWidth={2} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && children}
    </div>
  );
}

/**
 * Scrollable, color-coded log tail. Snaps to the bottom on mount (so opening it — including via
 * `Disclosure`, which mounts fresh each time it's expanded — always lands on the latest line
 * first) and keeps following new lines as long as the viewer is still near the bottom.
 */
export function LogViewer({
  lines,
  emptyMessage = "No log lines yet.",
  className = "min-h-0 flex-1",
}: {
  lines: LogLine[];
  emptyMessage?: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Not "first render": `lines` is usually still empty then (fetch is async), which would
  // consume the flag before there's anything to scroll to.
  const hasSnappedToBottom = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || lines.length === 0) return;
    if (!hasSnappedToBottom.current) {
      hasSnappedToBottom.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div ref={scrollRef} className={`overflow-y-auto px-4.5 py-3 ${className}`}>
      {lines.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-subtle">{emptyMessage}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all font-mono text-[11px] ${LOG_LEVEL_TONE[logLevel(l.line)]}`}>
              {l.line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExternalLinkButton({ txid }: { txid: string }) {
  return (
    <button
      type="button"
      title="View on explorer"
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(explorerTxUrl(txid));
      }}
      className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-control border border-line text-muted transition-colors hover:border-primary/60 hover:bg-primary/[0.14] hover:text-primary-hover"
    >
      <ExternalLink size={16} strokeWidth={1.8} />
    </button>
  );
}

/** Pairs with `ExternalLinkButton` on txid/address rows — same 34px footprint. */
export function CopyButton({ text, title = "Copy" }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-control border transition-colors ${
        copied ? "border-success/60 bg-success/[0.14] text-success" : "border-line text-muted hover:border-primary/60 hover:bg-primary/[0.14] hover:text-primary-hover"
      }`}
    >
      {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.8} />}
    </button>
  );
}

/**
 * Tinted by `walletIdentity`, so a folder of wallets is scannable by colour and monogram before
 * the name is even read. The lift uses `translate3d` deliberately: a plain `translateY` makes
 * WebKit re-rasterize the label and it visibly blurs mid-transition.
 */
export function WalletCard({ name, onClick }: { name: string; onClick: () => void }) {
  const id = walletIdentity(name);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ["--wallet-glow" as string]: id.glow }}
      className="group relative flex w-60 flex-col items-center gap-3 rounded-card border border-line bg-surface-raised/50 px-6 py-8 text-center outline-none transition-[transform,border-color,background-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:transform-[translate3d(0,-3px,0)] hover:border-line-strong hover:bg-surface-raised/75 focus-visible:border-primary/60 focus-visible:shadow-ring active:transform-[translate3d(0,-1px,0)] active:duration-75
        after:pointer-events-none after:absolute after:inset-0 after:rounded-card after:opacity-0 after:shadow-[0_18px_34px_-14px_rgba(0,0,0,0.85),0_0_22px_-6px_var(--wallet-glow)] after:transition-opacity after:duration-200 hover:after:opacity-100"
    >
      <span
        className="grid h-12 w-12 place-items-center rounded-lg border font-header text-[15px] font-bold"
        style={{ color: id.ink, background: id.fill, borderColor: id.edge }}
      >
        {id.monogram}
      </span>
      <span className="max-w-full truncate font-header text-[14px] font-bold text-foreground">{name}</span>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle transition-colors group-hover:text-muted">
        Unlock
      </span>
    </button>
  );
}
