/** Bitcoin targets a block every 10 minutes, so 144 a day. Approximate by construction. */
export function timelockDays(blocks: number): number {
  return Math.round(blocks / 144);
}

// Mirrors the backend's `valid_id`, so a rejected name is caught before the round trip.
export const ROUTER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Mirrors the backend's `MAX_ROUTER_NAME_LEN`, the longest name wallets accept.
export const ROUTER_NAME_MAX = 32;

/** The backend's name rule, so a name wallets would refuse is caught before the round trip. */
export function routerNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a public name.";
  // Code points, as the backend counts `chars()`.
  if ([...trimmed].length > ROUTER_NAME_MAX) return `At most ${ROUTER_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return "No control characters.";
  return null;
}
