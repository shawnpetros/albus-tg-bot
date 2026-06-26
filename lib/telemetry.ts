// Bot-owned status line, appended to every reply by poll.ts. Two jobs folded
// into one line:
//
//   1. Lock-state reminder. When unlocked, ALWAYS shown so the operator never
//      forgets to /lock. This replaces the old persona-typed footer (the model
//      used to append "🔓 still unlocked" itself, which was easy to forget).
//   2. Cost/context telemetry. Gated by showMetrics (ALBUS_SHOW_TELEMETRY): the
//      context fill against the live window, plus per-pass, per-session, and
//      per-day spend. Prep for the raw-API-cost era: you can't contain what you
//      can't see.
//
// Pure and side-effect-free: poll.ts feeds it the already-parsed numbers. The
// window denominator is whatever the model's result event advertised, so it
// tells the truth if the context window ever changes under us.

export interface StatusLineOpts {
  unlocked: boolean;
  // When false, only the lock reminder shows (no cost/context numbers).
  showMetrics: boolean;
  // True context fill: last assistant message's input-side total. 0 = unknown.
  contextTokens: number;
  // Live window advertised by the result event, or null if absent.
  contextWindow: number | null;
  // This turn's cost, the cumulative session cost, and the rolling day total.
  passCostUsd: number;
  sessionCostUsd: number;
  dailyCostUsd: number;
}

// Compact a token count: 58_000 -> "58k", 1_000_000 -> "1M", 1_200_000 ->
// "1.2M", 950 -> "950". Used for both the fill and the window denominator.
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return `${Math.round(v)}`;
}

// Cost string with sub-cent granularity where it matters: 4 decimals under a
// dime (a single pass is often a fraction of a cent), 2 decimals at or above.
export function formatCost(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v < 0.1 ? v.toFixed(4) : v.toFixed(2);
}

export function formatStatusLine(opts: StatusLineOpts): string {
  const {
    unlocked,
    showMetrics,
    contextTokens,
    contextWindow,
    passCostUsd,
    sessionCostUsd,
    dailyCostUsd,
  } = opts;

  let metrics = "";
  if (showMetrics) {
    const parts: string[] = [];
    if (contextTokens > 0) {
      if (contextWindow && contextWindow > 0) {
        const pct = Math.round((contextTokens / contextWindow) * 100);
        parts.push(
          `${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${pct}%)`
        );
      } else {
        parts.push(`${formatTokens(contextTokens)} ctx`);
      }
    }
    parts.push(
      `$${formatCost(passCostUsd)} pass · $${formatCost(sessionCostUsd)} sess · $${formatCost(dailyCostUsd)} day`
    );
    metrics = parts.join(" · ");
  }

  if (unlocked) {
    return metrics
      ? `🔓 ${metrics} · /lock when done`
      : `🔓 still unlocked - /lock when done`;
  }
  // Locked: show telemetry if asked, otherwise stay silent (no footer), which
  // preserves the original locked-mode "no footer" behavior.
  return metrics ? `🔒 ${metrics}` : "";
}
