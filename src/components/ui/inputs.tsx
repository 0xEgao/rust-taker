import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { motion } from "framer-motion";
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  arrow?: boolean; // trailing arrow, e.g. "Test node connection →"
}

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-[box-shadow,background-color,border-color,transform,color] duration-200 disabled:cursor-not-allowed disabled:opacity-50";

const buttonVariants: Record<Variant, string> = {
  // Top-lit: a 1px inner highlight plus an accent-tinted drop shadow, so a filled control reads
  // as raised rather than as a coloured rectangle. Presses translate down and swap the outer
  // shadow for an inner one — the shadow is what sells the press, not the 1px move.
  primary:
    "bg-primary text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,0,0,0.4),0_8px_20px_-8px_color-mix(in_oklab,var(--color-primary)_50%,transparent)] hover:bg-primary-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(0,0,0,0.4),0_12px_28px_-8px_color-mix(in_oklab,var(--color-primary)_68%,transparent)] active:translate-y-px active:shadow-[inset_0_1px_3px_rgba(0,0,0,0.28)] disabled:shadow-none",
  secondary:
    "border border-line bg-surface-raised text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-line-strong hover:bg-secondary-hover active:translate-y-px",
  ghost: "text-muted hover:text-foreground",
};

const buttonSizes: Record<Size, string> = {
  md: "h-10 px-5 text-[13px]",
  sm: "h-8 px-4 text-[12px]",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  arrow = false,
  disabled,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70" />
      )}
      {children}
      {arrow && !loading && <ArrowRight size={15} strokeWidth={2} />}
    </button>
  );
}

/**
 * A settled value that can be edited in place. Deliberately not a `TextField`: a form of
 * bordered boxes reads as decisions demanded up front, which is the thing this avoids — at
 * rest the row is information, and the input only appears once asked for.
 */
export function SummaryRow({
  label,
  value,
  display,
  suffix,
  inputMode = "numeric",
  onCommit,
}: {
  label: string;
  /** The raw text, and what an edit starts from. */
  value: string;
  /** Prettified form shown at rest, e.g. thousands separators. Editing still uses `value`. */
  display?: string;
  /** Unit rendered after the value, e.g. "sats" — never part of the edited text. */
  suffix?: string;
  inputMode?: "numeric" | "decimal" | "text";
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function open() {
    setDraft(value);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
  }

  return (
    <div className="flex min-h-9 items-center justify-between gap-4 text-[12.5px]">
      <span className="text-muted">{label}</span>
      {editing ? (
        <input
          autoFocus
          inputMode={inputMode}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            // Blur would otherwise fire after this and commit the abandoned draft.
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          // Sized to the value, not the column: a full-width box is the chrome being avoided.
          className="w-28 border-b border-primary bg-transparent pb-0.5 text-right font-mono text-[12.5px] text-foreground outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={open}
          className="group flex items-center gap-2 text-right transition-colors hover:text-primary"
        >
          <span className="font-mono text-foreground group-hover:text-primary">
            {display ?? value}
            {suffix && <span className="ml-1 text-subtle group-hover:text-primary">{suffix}</span>}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-subtle group-hover:text-primary">Edit</span>
        </button>
      )}
    </div>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function TextField({ label, error, hint, id, className = "", ...props }: TextFieldProps) {
  const inputId = id ?? useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[12.5px] font-medium text-muted">
        {label}
      </label>
      <input
        id={inputId}
        className={`h-10 rounded-control border bg-surface-raised px-3 text-[13px] text-foreground outline-none transition-colors duration-200 placeholder:text-subtle ${
          error ? "border-danger bg-danger/5" : "border-line focus:border-primary focus:shadow-ring"
        } ${className}`}
        {...props}
      />
      {error ? (
        <span className="text-[11.5px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11.5px] text-subtle">{hint}</span>
      ) : null}
    </div>
  );
}

interface PasswordFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function PasswordField({
  label,
  error,
  hint,
  id,
  className = "",
  ...props
}: PasswordFieldProps) {
  const inputId = id ?? useId();
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[12.5px] font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          className={`h-10 w-full rounded-control border bg-surface-raised px-3 pr-10 text-[13px] text-foreground outline-none transition-colors duration-200 placeholder:text-subtle ${
            error ? "border-danger bg-danger/5" : "border-line focus:border-primary focus:shadow-ring"
          } ${className}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-subtle hover:text-muted"
        >
          {visible ? <EyeOff size={16} strokeWidth={1.6} /> : <Eye size={16} strokeWidth={1.6} />}
        </button>
      </div>
      {error ? (
        <span className="text-[11.5px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11.5px] text-subtle">{hint}</span>
      ) : null}
    </div>
  );
}

interface FieldChipProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
}

/** Compact "LABEL: value" input for tight spaces; use TextField when a hint/error row is needed. */
export function FieldChip({ label, className = "", ...props }: FieldChipProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-control border border-line bg-surface-raised px-3 py-2 transition-colors duration-200 focus-within:border-primary">
      <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-subtle">
        {label}:
      </span>
      <input
        className={`w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle ${className}`}
        {...props}
      />
    </div>
  );
}

const SEGMENTED_GLOW_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.6 };

/** Pill toggle with an animated glow that slides between options; used for unit/mode/protocol switches. */
export function SegmentedToggle<T extends string>({
  groupId,
  value,
  onChange,
  options,
}: {
  groupId: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean; title?: string; suffix?: ReactNode }[];
}) {
  // No track fill: the page shows straight through, and only the active option is painted.
  return (
    <div className="inline-flex items-center gap-1 rounded-full p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={opt.disabled}
          onClick={() => onChange(opt.value)}
          title={opt.title}
          className={`relative flex min-h-[30px] items-center gap-1 whitespace-nowrap rounded-full px-3.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === opt.value ? "text-primary" : "text-muted hover:text-foreground"
          }`}
        >
          {value === opt.value && (
            <motion.span
              layoutId={`toggle-glow-${groupId}`}
              transition={SEGMENTED_GLOW_TRANSITION}
              className="absolute inset-0 -z-10 rounded-full bg-primary/15 shadow-glow"
            />
          )}
          {opt.label}
          {opt.suffix}
        </button>
      ))}
    </div>
  );
}

/** Two-state-per-key sort control built on `SegmentedToggle`: clicking the active key flips its direction. */
export function SortToggle<T extends string>({
  groupId,
  sortKey,
  sortDir,
  onChange,
  options,
}: {
  groupId: string;
  sortKey: T;
  sortDir: Record<T, "asc" | "desc">;
  onChange: (key: T) => void;
  options: { key: T; label: string }[];
}) {
  return (
    <SegmentedToggle
      groupId={groupId}
      value={sortKey}
      onChange={onChange}
      options={options.map((opt) => ({
        value: opt.key,
        label: opt.label,
        suffix: <span>{sortDir[opt.key] === "desc" ? "↓" : "↑"}</span>,
      }))}
    />
  );
}
