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
  "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50";

const buttonVariants: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "border border-line bg-surface-raised text-foreground hover:border-line-strong",
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
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      )}
      {children}
      {arrow && !loading && <ArrowRight size={15} strokeWidth={2} />}
    </button>
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
          error ? "border-danger bg-danger/5" : "border-line focus:border-primary focus:shadow-[0_0_0_3px_rgba(90,140,255,0.15)]"
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
            error ? "border-danger bg-danger/5" : "border-line focus:border-primary focus:shadow-[0_0_0_3px_rgba(90,140,255,0.15)]"
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
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white/[0.02] p-1">
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
              className="absolute inset-0 -z-10 rounded-full bg-primary/15 shadow-[0_0_12px_rgba(90,140,255,0.35)]"
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
