// ── Flow Intelligence Engine — Similar Day Retrieval ─────────────────────────
// Converts each session into a comparable feature signature and finds similar days.

import type {
  SessionSignature, SimilarDay, FlowEvent, RegimeSummary, WallState, MoveInstance,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// SESSION SIGNATURE COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a session signature from the day's events, regime, and walls.
 * Called at EOD.
 */
export function computeSessionSignature(
  date: string,
  events: FlowEvent[],
  regime: RegimeSummary,
  walls: WallState,
  moves: MoveInstance[],
  spot: number,
  daysToExpiry: number
): SessionSignature {
  const total = events.length || 1;

  // Herfindahl index of OI concentration (events per strike)
  const strikeEventCounts: Record<number, number> = {};
  for (const e of events) {
    strikeEventCounts[e.strike] = (strikeEventCounts[e.strike] ?? 0) + 1;
  }
  const strikeShares = Object.values(strikeEventCounts).map(c => c / total);
  const oiConcentrationHHI = strikeShares.reduce((s, x) => s + x * x, 0);

  // OI imbalance
  const callOi = events.filter(e => e.side === "CALL" && e.type === "FRESH_WRITING").length;
  const putOi  = events.filter(e => e.side === "PUT"  && e.type === "FRESH_WRITING").length;
  const callPutOiImbalance = (callOi - putOi) / (callOi + putOi + 1);

  // IV expansion rate
  const ivShocks = events.filter(e => e.type === "IV_SHOCK").length;
  const ivExpansionRate = ivShocks / total;

  // Event fractions
  const freshWritingFrac = events.filter(e => e.type === "FRESH_WRITING").length / total;
  const longBuildupFrac  = events.filter(e => e.type === "LONG_BUILDUP").length / total;
  const churnFrac        = events.filter(e => e.type === "CHURN").length / total;
  const sweepFrac        = events.filter(e => e.type === "LIQUIDITY_SWEEP").length / total;

  // Session outcome
  const todayMove = moves.find(m => m.date === date);
  const direction = todayMove
    ? todayMove.direction
    : regime.directionalEfficiency > 0.15 ? "UP"
    : regime.directionalEfficiency < -0.15 ? "DOWN"
    : "FLAT";
  const magnitude = todayMove?.magnitude ?? 0;

  return {
    date,
    features: {
      oiConcentrationHHI,
      callPutOiImbalance,
      ivExpansionRate,
      freshWritingFrac,
      longBuildupFrac,
      churnFrac,
      sweepFrac,
      wallMigrationCount: walls.recentMigrations.length,
      breadthScore: regime.breadthScore,
      directionalEfficiency: regime.directionalEfficiency,
      sessionVolatility: Math.abs(regime.directionalEfficiency),
      expiryProximityDays: daysToExpiry,
    },
    outcome: {
      direction: direction as "UP" | "DOWN" | "FLAT",
      magnitude,
      regime: regime.regime,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COSINE SIMILARITY (session-level)
// ─────────────────────────────────────────────────────────────────────────────

function sigToVector(s: SessionSignature): number[] {
  const f = s.features;
  return [
    f.oiConcentrationHHI,
    f.callPutOiImbalance * 0.5 + 0.5, // shift to [0,1]
    f.ivExpansionRate,
    f.freshWritingFrac,
    f.longBuildupFrac,
    f.churnFrac,
    f.sweepFrac,
    Math.min(1, f.wallMigrationCount / 5),
    f.breadthScore,
    f.directionalEfficiency * 0.5 + 0.5,
    f.sessionVolatility,
    Math.min(1, f.expiryProximityDays / 30),
  ];
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const magB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  if (magA === 0 || magB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (magA * magB)));
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMILAR DAY RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOME_DESCRIPTIONS: Record<string, string> = {
  TREND_UP:             "Trended up through the session",
  TREND_DOWN:           "Trended down through the session",
  RANGE_DAY:            "Remained in a tight range",
  EXPIRY_PIN:           "Pinned near max pain into close",
  SHORT_COVERING:       "Sharp short-covering rally",
  LONG_UNWINDING:       "Gradual long unwinding, mild decline",
  TRAP_HEAVY:           "Multiple traps, choppy action",
  HIGH_VOL_EVENT:       "High-volatility event-driven session",
  LOW_CONVICTION_CHURN: "Churned with no clear direction",
  UNKNOWN:              "Mixed session",
};

/**
 * Find top N sessions from stored signatures most similar to the current session.
 */
export function findSimilarDays(
  current: SessionSignature,
  stored: SessionSignature[],
  topN = 5
): SimilarDay[] {
  const currentDate = current.date;
  const currentVec = sigToVector(current);

  const candidates = stored
    .filter(s => s.date !== currentDate)
    .map(s => ({
      s,
      similarity: cosine(currentVec, sigToVector(s)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);

  return candidates.map(({ s, similarity }) => {
    const matchingFeatures = identifyMatchingFeatures(current, s);
    const outcomeDesc = OUTCOME_DESCRIPTIONS[s.outcome.regime] ?? "Similar flow structure";
    const note = `${outcomeDesc}. ${
      s.outcome.magnitude > 0
        ? `Market moved ${s.outcome.direction === "UP" ? "up" : "down"} ~${s.outcome.magnitude} pts.`
        : "No significant directional move."
    }`;

    return {
      date: s.date,
      similarity: Math.round(similarity * 100) / 100,
      matchingFeatures,
      regime: s.outcome.regime,
      outcome: s.outcome,
      note,
    };
  });
}

function identifyMatchingFeatures(a: SessionSignature, b: SessionSignature): string[] {
  const matches: string[] = [];
  const af = a.features, bf = b.features;

  if (Math.abs(af.freshWritingFrac - bf.freshWritingFrac) < 0.1)
    matches.push("Similar writing activity level");
  if (Math.abs(af.churnFrac - bf.churnFrac) < 0.1)
    matches.push("Similar churn level");
  if (Math.abs(af.directionalEfficiency - bf.directionalEfficiency) < 0.15)
    matches.push("Similar directional efficiency");
  if (Math.abs(af.breadthScore - bf.breadthScore) < 0.15)
    matches.push("Similar conviction breadth");
  if (Math.abs(af.ivExpansionRate - bf.ivExpansionRate) < 0.05)
    matches.push("Similar IV expansion");
  if (Math.abs(af.wallMigrationCount - bf.wallMigrationCount) <= 1)
    matches.push("Similar wall migration count");
  if (Math.sign(af.callPutOiImbalance) === Math.sign(bf.callPutOiImbalance))
    matches.push("Same call/put directional bias");

  return matches.slice(0, 4);
}
