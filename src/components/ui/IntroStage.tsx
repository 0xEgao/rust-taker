import { motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";

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

// Tiled fractal noise. Large flat fills of a single dark colour band and read as plastic on
// this much empty screen; a few percent of grain is what keeps them looking like a surface.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)'/%3E%3C/svg%3E\")";

/**
 * Light and texture for the stage, over the app's shared background. Absolute rather than
 * fixed so it stays inside the stage when this runs as a page rather than a whole screen, and
 * fades in with the wordmark so the first beat still opens on an empty ground.
 */
function IntroBackdrop() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
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
      <div className="absolute inset-0 opacity-[0.045]" style={{ backgroundImage: GRAIN }} />
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
  className = "",
  children,
}: {
  lead: string;
  accent: string;
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setStage(1), WORDMARK_UP_MS),
      setTimeout(() => setStage(2), CAPTION_IN_MS),
      setTimeout(() => setStage(3), CAPTION_UP_MS),
      setTimeout(() => setStage(4), BODY_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className={`relative flex flex-col items-center overflow-hidden px-4 pb-16 pt-[14vh] text-center ${className}`}>
      <IntroBackdrop />

      {/* Arrival and travel sit on separate nodes: scale and y both write `transform`, so one
          element cannot animate them independently. */}
      <motion.h1
        initial={{ y: WORDMARK_FROM }}
        animate={{ y: stage >= 1 ? "0vh" : WORDMARK_FROM }}
        transition={{ duration: 0.7, ease: RISE }}
        className="relative font-header text-[48px] font-bold leading-[1.15] text-foreground"
      >
        <motion.span
          className="inline-block"
          initial={{ opacity: 0, scale: 0.55, filter: "blur(18px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.85, delay: 0.35, ease: RISE }}
        >
          {lead} <em className="italic text-primary">{accent}</em>
        </motion.span>
      </motion.h1>

      {stage >= 2 && (
        <motion.p
          initial={{ opacity: 0, y: CAPTION_FROM, fontSize: CAPTION_LEAD_PX }}
          animate={{
            opacity: 1,
            y: stage >= 3 ? "0vh" : CAPTION_FROM,
            fontSize: stage >= 3 ? CAPTION_PX : CAPTION_LEAD_PX,
          }}
          transition={{ duration: 0.65, ease: RISE, opacity: { duration: 0.45 } }}
          className="relative mt-5 leading-[1.15] text-muted"
        >
          {caption}
        </motion.p>
      )}

      {stage >= 4 && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
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
