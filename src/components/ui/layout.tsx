/** Solid base + one soft left-of-center glow (fades in all directions, no hard edge) + a barely-there dotted grid. */
export function Background() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden bg-bg">
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 75% 65% at 22% 58%, color-mix(in oklab, var(--color-primary) 18%, transparent), transparent 70%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />
    </div>
  );
}
