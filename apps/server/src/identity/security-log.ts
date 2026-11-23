/**
 * Security-event log (design doc, Logging Rules). One structured
 * `console.warn` JSON line per event; callers pass only spec-allowed
 * identifiers (never secret material, never `init_token_id` on wrong-code
 * guesses). `JSON.stringify` escapes control characters, so one event is
 * always exactly one line; `ip` is also length-capped.
 */
const MAX_IP_CHARS = 64;
const THROTTLE_MS = 60_000;

interface SecurityEventFields {
  ip: string;
  outcome?: "rejected" | "rate_limited";
  credential_id?: string;
  agent_id?: string;
}

// `rate_limited` lines are not bounded by the limiter itself (an over-limit
// request is a cheap 429), so they alone are throttled: one line per event
// NAME per window (not per IP, so rotating IPs cannot bypass it), then the
// next line reports `suppressed`. Process-local; resets on restart.
const throttle = new Map<string, { at: number; suppressed: number }>();

export function resetSecurityLogThrottle(): void {
  throttle.clear();
}

export function logSecurityEvent(
  event: string,
  fields: SecurityEventFields,
): void {
  const now = Date.now();
  let suppressed: number | undefined;
  if (fields.outcome === "rate_limited") {
    const slot = throttle.get(event);
    if (slot !== undefined && now - slot.at < THROTTLE_MS) {
      slot.suppressed += 1;
      return;
    }
    if (slot !== undefined && slot.suppressed > 0) suppressed = slot.suppressed;
    throttle.set(event, { at: now, suppressed: 0 });
  }
  console.warn(
    JSON.stringify({
      event,
      ...fields,
      ip: fields.ip.slice(0, MAX_IP_CHARS),
      ...(suppressed !== undefined ? { suppressed } : {}),
      at: new Date(now).toISOString(),
    }),
  );
}
