import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

// Absolute beats rather than chained animation callbacks, so the whole sequence reads in one
// place: blank → wordmark arrives centre stage → it docks at the top → the caption repeats that
// move at wordmark size, shrinking to its own on the way → body.
const WORDMARK_UP_MS = 1450;
const CAPTION_IN_MS = 2200;
const CAPTION_UP_MS = 3000;
const BODY_MS = 3700;

const RISE = [0.16, 1, 0.3, 1] as const;

// Drops that put each line at the viewport's vertical middle before it docks: vh so they hold
// across window sizes, and expressed in the same unit at both ends so framer can interpolate.
const WORDMARK_FROM = "32vh";
const CAPTION_FROM = "24.5vh";

// The caption arrives large but deliberately below the wordmark's 48px, so it reads as the line
// under the title rather than a second title.
const CAPTION_LEAD_PX = "34px";
const CAPTION_PX = "16px";

/**
 * Light and texture for the stage, over the app's shared background. Absolute rather than
 * fixed so it stays inside the stage when this runs as a page rather than a whole screen, and
 * fades in with the wordmark so the first beat still opens on an empty ground.
 */
function IntroBackdrop({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.div
      initial={{ opacity: reduceMotion ? 1 : 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.8, delay: 0.35, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Bloom the wordmark appears out of, and a far horizon so the lower half still carries
          light once the body has docked at the top. */}
      <div
        className="absolute inset-x-0 top-0 h-[72vh]"
        style={{ background: "radial-gradient(ellipse 58% 100% at 50% -4%, color-mix(in oklab, var(--color-primary) 22%, transparent), transparent 70%)" }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[50vh]"
        style={{ background: "radial-gradient(ellipse 95% 100% at 50% 118%, color-mix(in oklab, var(--color-primary) 13%, transparent), transparent 72%)" }}
      />
      <div className="grain absolute inset-0 opacity-[0.045]" />
    </motion.div>
  );
}

/**
 * Wordmark arrival plus the frame its body sits in. Mounted once per visit, so changing the
 * caption and body afterwards never replays the arrival. Callers set the height — a full
 * screen for setup, the page area for a route inside the shell.
 */
export function IntroStage({
  lead,
  accent,
  caption,
  back,
  instant = false,
  onDone,
  className = "",
  children,
}: {
  lead: string;
  accent: string;
  caption: string;
  back?: { to: string; label: string; title: string };
  instant?: boolean;
  onDone?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [stage, setStage] = useState(instant ? 4 : 0);
  const reduceMotion = useReducedMotion() ?? false;
  // Held in a ref so an inline callback re-created on every render can't restart the sequence.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (reduceMotion || instant) {
      setStage(4);
      onDoneRef.current?.();
      return;
    }
    const timers = [
      setTimeout(() => setStage(1), WORDMARK_UP_MS),
      setTimeout(() => setStage(2), CAPTION_IN_MS),
      setTimeout(() => setStage(3), CAPTION_UP_MS),
      setTimeout(() => {
        setStage(4);
        onDoneRef.current?.();
      }, BODY_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [reduceMotion, instant]);

  return (
    <div className={`relative flex flex-col items-center overflow-hidden px-4 pb-16 pt-[14vh] text-center ${className}`}>
      <IntroBackdrop reduceMotion={reduceMotion} />

      {stage >= 4 && back && (
        <motion.div
          initial={{ opacity: reduceMotion || instant ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="absolute left-8 top-5 z-10"
        >
          {/* The shell's maker-mode logo, repeated: leaving a side of the app is the same
              control wherever the user meets it. */}
          <Link
            to={back.to}
            title={back.title}
            className="flex items-center gap-2 rounded-control font-header text-[15px] font-bold text-foreground outline-none transition-colors hover:text-primary focus-visible:shadow-ring"
          >
            <ArrowLeft size={16} strokeWidth={2} className="text-primary" />
            {back.label}
          </Link>
        </motion.div>
      )}

      {/* Arrival and travel sit on separate nodes: scale and y both write `transform`, so one
          element cannot animate them independently. */}
      <motion.h1
        initial={{ y: reduceMotion ? "0vh" : WORDMARK_FROM }}
        animate={{ y: reduceMotion || stage >= 1 ? "0vh" : WORDMARK_FROM }}
        transition={{ duration: 0.7, ease: RISE }}
        className="relative font-header text-[48px] font-bold leading-[1.15] text-foreground"
      >
        <motion.span
          className="inline-block"
          initial={{ opacity: reduceMotion ? 1 : 0, scale: reduceMotion ? 1 : 0.55, filter: reduceMotion ? "blur(0px)" : "blur(18px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.85, delay: 0.35, ease: RISE }}
        >
          {lead} <em className="italic text-primary">{accent}</em>
        </motion.span>
      </motion.h1>

      {stage >= 2 && (
        <motion.p
          initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? "0vh" : CAPTION_FROM, fontSize: reduceMotion ? CAPTION_PX : CAPTION_LEAD_PX }}
          animate={{
            opacity: 1,
            y: reduceMotion || stage >= 3 ? "0vh" : CAPTION_FROM,
            fontSize: reduceMotion || stage >= 3 ? CAPTION_PX : CAPTION_LEAD_PX,
          }}
          transition={{ duration: 0.65, ease: RISE, opacity: { duration: 0.45 } }}
          className="relative mt-5 leading-[1.15] text-muted"
        >
          {caption}
        </motion.p>
      )}

      {stage >= 4 && (
        <motion.div
          initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="relative mt-9 w-full"
        >
          {children}
        </motion.div>
      )}

    </div>
  );
}
