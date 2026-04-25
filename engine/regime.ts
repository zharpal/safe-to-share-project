// ── Flow Intelligence Engine — Market Regime Classifier ──────────────────────
// Classifies the current session's market regime from events and features.

import type {
  FlowEvent, FlowEventType, RegimeSummary, RegimeLabel, BarFeatures,
} from "./types.js";
import {
  computeBreadthScore, computeDirectionalEfficiency, computeIvTrend,
} from "./features.js";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function countEvents(events: FlowEvent[]): Record<FlowEventType, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts as Record<FlowEventType, number>;
}

function frac(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIME SCORING
// ─────────────────────────────────────────────────────────────────────────────

interface RegimeScore {
  regime: RegimeLabel;
  score: number;
  reasons: string[];
}

function scoreTrendUp(counts: Record<FlowEventType, number>, total: number, dirEff: number, ivTrend: string, breadth: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;

  const longBuildFrac = frac((counts.LONG_BUILDUP ?? 0), total);
  const writingFrac   = frac((counts.FRESH_WRITING ?? 0), total);
  const coverFrac     = frac((counts.SHORT_COVERING ?? 0), total);

  if (longBuildFrac > 0.25) { score += 25; reasons.push(`${(longBuildFrac * 100).toFixed(0)}% of events are long buildup`); }
  if (dirEff > 0.3)         { score += 20; reasons.push("Bullish directional efficiency dominant"); }
  if (breadth > 0.5)        { score += 15; reasons.push("Broad-based conviction across strikes"); }
  if (coverFrac > 0.15)     { score += 10; reasons.push("Short covering accelerating"); }
  if (ivTrend === "EXPANDING") { score += 5; reasons.push("IV expansion confirms upside premium demand"); }
  // Writing on puts = bullish (put sellers confident in floor)
  const putWritingCount = (counts.FRESH_WRITING ?? 0);
  if (putWritingCount > 3 && writingFrac > 0.1) { score += 10; reasons.push("Put writing adds support floor"); }

  return { regime: "TREND_UP", score, reasons };
}

function scoreTrendDown(counts: Record<FlowEventType, number>, total: number, dirEff: number, ivTrend: string, breadth: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;

  const longUnwindFrac = frac((counts.LONG_UNWINDING ?? 0), total);
  const writingFrac    = frac((counts.FRESH_WRITING ?? 0), total);

  if (longUnwindFrac > 0.20) { score += 25; reasons.push(`${(longUnwindFrac * 100).toFixed(0)}% of events are long unwinding`); }
  if (dirEff < -0.3)         { score += 20; reasons.push("Bearish directional efficiency dominant"); }
  if (breadth > 0.5)         { score += 15; reasons.push("Broad-based selling across strikes"); }
  if (writingFrac > 0.2)     { score += 10; reasons.push("Call writing creating resistance ceiling"); }
  if (ivTrend === "EXPANDING") { score += 8; reasons.push("IV expansion consistent with fear/downside"); }

  return { regime: "TREND_DOWN", score, reasons };
}

function scoreRangeDay(counts: Record<FlowEventType, number>, total: number, dirEff: number, ivTrend: string, breadth: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;

  const churnFrac  = frac((counts.CHURN ?? 0), total);
  const absorpFrac = frac((counts.ABSORPTION ?? 0), total);
  const wallFrac   = frac((counts.WALL_CREATION ?? 0), total);

  if (churnFrac > 0.25)    { score += 25; reasons.push(`High churn fraction (${(churnFrac * 100).toFixed(0)}%) — no conviction`); }
  if (Math.abs(dirEff) < 0.15) { score += 20; reasons.push("Balanced directional efficiency — both sides fighting"); }
  if (absorpFrac > 0.10)   { score += 15; reasons.push("Absorption events dominating — supply being matched"); }
  if (wallFrac > 0.10)     { score += 15; reasons.push("Wall creation events — range being enforced"); }
  if (ivTrend === "COMPRESSING") { score += 10; reasons.push("IV compression — sellers milking theta"); }
  if (breadth < 0.3)       { score += 10; reasons.push("Low conviction breadth — quiet, range-bound"); }

  return { regime: "RANGE_DAY", score, reasons };
}

function scoreExpiryPin(counts: Record<FlowEventType, number>, total: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const pinFrac = frac((counts.EXPIRY_PIN ?? 0), total);
  if (pinFrac > 0.10) { score += 50; reasons.push(`Expiry pin events detected (${(counts.EXPIRY_PIN ?? 0)} events)`); }
  if (counts.FRESH_WRITING ?? 0 > 3) { score += 20; reasons.push("Active writing consistent with max-pain defense"); }
  return { regime: "EXPIRY_PIN", score, reasons };
}

function scoreShortCovering(counts: Record<FlowEventType, number>, total: number, dirEff: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const coverFrac = frac((counts.SHORT_COVERING ?? 0), total);
  if (coverFrac > 0.30) { score += 40; reasons.push(`Dominant short covering (${(coverFrac * 100).toFixed(0)}% of events)`); }
  if (dirEff > 0.2)     { score += 20; reasons.push("Net bullish flow confirming covering pressure"); }
  if (counts.LIQUIDITY_SWEEP ?? 0 > 2) { score += 15; reasons.push("Sweep events suggest aggressive short exit"); }
  return { regime: "SHORT_COVERING", score, reasons };
}

function scoreLongUnwinding(counts: Record<FlowEventType, number>, total: number, dirEff: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const unwindFrac = frac((counts.LONG_UNWINDING ?? 0), total);
  if (unwindFrac > 0.30) { score += 40; reasons.push(`Dominant long unwinding (${(unwindFrac * 100).toFixed(0)}% of events)`); }
  if (dirEff < -0.2)     { score += 20; reasons.push("Net bearish flow confirming long exit pressure"); }
  return { regime: "LONG_UNWINDING", score, reasons };
}

function scoreTrapHeavy(counts: Record<FlowEventType, number>, total: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const sweepFrac  = frac((counts.LIQUIDITY_SWEEP ?? 0), total);
  const absorpFrac = frac((counts.ABSORPTION ?? 0), total);
  if (sweepFrac > 0.15)  { score += 35; reasons.push(`Liquidity sweeps detected (${(sweepFrac * 100).toFixed(0)}% of events)`); }
  if (absorpFrac > 0.15) { score += 25; reasons.push(`Absorption events suggest hidden supply/demand`); }
  if ((counts.WALL_MIGRATION ?? 0) > 2) { score += 20; reasons.push("Wall migration suggests trap repositioning"); }
  return { regime: "TRAP_HEAVY", score, reasons };
}

function scoreHighVol(counts: Record<FlowEventType, number>, total: number, ivTrend: string): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const ivShockFrac = frac((counts.IV_SHOCK ?? 0), total);
  if (ivShockFrac > 0.15)    { score += 40; reasons.push(`IV shock events dominating (${(ivShockFrac * 100).toFixed(0)}%)`); }
  if (ivTrend === "EXPANDING") { score += 25; reasons.push("Broad IV expansion — event-driven session"); }
  return { regime: "HIGH_VOL_EVENT", score, reasons };
}

function scoreChurn(counts: Record<FlowEventType, number>, total: number, breadth: number): RegimeScore {
  const reasons: string[] = [];
  let score = 0;
  const churnFrac = frac((counts.CHURN ?? 0), total);
  if (churnFrac > 0.35) { score += 45; reasons.push(`Very high churn fraction (${(churnFrac * 100).toFixed(0)}%)`); }
  if (breadth < 0.2)    { score += 30; reasons.push("Very low conviction breadth across strikes"); }
  return { regime: "LOW_CONVICTION_CHURN", score, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify the current session's market regime.
 *
 * @param events - All flow events detected today
 * @param allFeatures - Latest BarFeatures for all active strikes
 * @param spot - Current Nifty spot
 * @param date - YYYY-MM-DD
 * @param priorRegime - Previous regime (for change detection)
 */
export function classifyRegime(
  events: FlowEvent[],
  allFeatures: Map<number, BarFeatures>,
  spot: number,
  date: string,
  priorRegime?: RegimeSummary
): RegimeSummary {
  const computedAt = new Date().toISOString();

  if (events.length === 0 || allFeatures.size === 0) {
    return {
      date, computedAt,
      regime: "UNKNOWN",
      confidence: 0,
      bias: "NEUTRAL",
      reasons: ["Insufficient data — waiting for market activity."],
      eventCounts: {} as any,
      breadthScore: 0,
      directionalEfficiency: 0,
      ivTrend: "STABLE",
    };
  }

  const counts     = countEvents(events);
  const total      = events.length;
  const breadth    = computeBreadthScore(allFeatures);
  const dirEff     = computeDirectionalEfficiency(allFeatures);
  const ivTrend    = computeIvTrend(allFeatures);

  // Score all regime types
  const scores: RegimeScore[] = [
    scoreTrendUp(counts, total, dirEff, ivTrend, breadth),
    scoreTrendDown(counts, total, dirEff, ivTrend, breadth),
    scoreRangeDay(counts, total, dirEff, ivTrend, breadth),
    scoreExpiryPin(counts, total),
    scoreShortCovering(counts, total, dirEff),
    scoreLongUnwinding(counts, total, dirEff),
    scoreTrapHeavy(counts, total),
    scoreHighVol(counts, total, ivTrend),
    scoreChurn(counts, total, breadth),
  ];

  scores.sort((a, b) => b.score - a.score);
  const winner = scores[0];
  const runnerUp = scores[1];

  // Confidence = how dominant the winner is vs runner-up
  const gap = winner.score - runnerUp.score;
  const confidence = Math.min(95, Math.max(20, winner.score > 0 ? 40 + gap * 2 : 20));

  // Bias from directional efficiency
  const bias = dirEff > 0.15 ? "BULLISH" : dirEff < -0.15 ? "BEARISH" : "NEUTRAL";

  return {
    date,
    computedAt,
    regime: winner.regime,
    confidence: Math.round(confidence),
    bias,
    reasons: winner.reasons.slice(0, 5),
    eventCounts: counts,
    breadthScore: Math.round(breadth * 100) / 100,
    directionalEfficiency: Math.round(dirEff * 100) / 100,
    ivTrend,
    priorRegime: priorRegime?.regime,
    priorRegimeAt: priorRegime?.computedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIME DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export const REGIME_LABELS: Record<RegimeLabel, string> = {
  TREND_UP:              "Trend Up",
  TREND_DOWN:            "Trend Down",
  RANGE_DAY:             "Range Day",
  EXPIRY_PIN:            "Expiry Pin",
  SHORT_COVERING:        "Short Covering",
  LONG_UNWINDING:        "Long Unwinding",
  TRAP_HEAVY:            "Trap Heavy",
  HIGH_VOL_EVENT:        "High Vol Event",
  LOW_CONVICTION_CHURN:  "Low Conviction",
  UNKNOWN:               "Analysing…",
};

export const REGIME_COLORS: Record<RegimeLabel, string> = {
  TREND_UP:              "emerald",
  TREND_DOWN:            "rose",
  RANGE_DAY:             "blue",
  EXPIRY_PIN:            "violet",
  SHORT_COVERING:        "teal",
  LONG_UNWINDING:        "orange",
  TRAP_HEAVY:            "amber",
  HIGH_VOL_EVENT:        "red",
  LOW_CONVICTION_CHURN:  "slate",
  UNKNOWN:               "gray",
};
