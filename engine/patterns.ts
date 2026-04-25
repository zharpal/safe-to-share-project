// ── Flow Intelligence Engine — Pattern Memory ─────────────────────────────────
// Stores pre-move precursor patterns, tracks outcomes, computes similarity.

import type {
  PrecursorPattern, FeatureVector, PatternMatch, MoveInstance,
  RegimeSummary, WallState, FlowEvent, BarFeatures,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN MEMORY CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PATTERNS = 200;
const DECAY_DAYS   = 60; // patterns not seen in 60+ days get reliability penalty

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE VECTOR COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a normalised [0,1] FeatureVector from current market state.
 * Used for cosine similarity comparison.
 */
export function buildFeatureVector(
  allFeatures: Map<number, BarFeatures>,
  regime: RegimeSummary,
  walls: WallState,
  events: FlowEvent[],
  spot: number
): FeatureVector {
  if (allFeatures.size === 0) {
    return {
      callPutOiImbalance: 0.5, ivLevel: 0.5, ivTrend: 0.5,
      breadthScore: 0, coiEfficiency: 0, wallMigrationRecent: 0,
      churnRatio: 0, writingRatio: 0, buildupRatio: 0,
      sweepRecent: 0, distFromMaxPain: 0.5,
    };
  }

  // OI imbalance: call OI vs put OI across ATM ±300
  let callOiSum = 0, putOiSum = 0, ivSum = 0, effSum = 0, count = 0;
  const atm = Math.round(spot / 50) * 50;
  allFeatures.forEach(f => {
    if (Math.abs(f.strike - atm) > 300) return;
    callOiSum += f.callCoi;
    putOiSum  += f.putCoi;
    ivSum     += (f.callIv + f.putIv) / 2;
    effSum    += (f.callCoiEfficiency + f.putCoiEfficiency) / 2;
    count++;
  });

  // Normalise OI imbalance to [0,1]: 0.5 = balanced, 1 = all call, 0 = all put
  const totalAbsOi = Math.abs(callOiSum) + Math.abs(putOiSum);
  const callPutOiImbalance = totalAbsOi > 0
    ? 0.5 + (callOiSum - putOiSum) / (2 * totalAbsOi)
    : 0.5;

  // Normalise IV: assume 10–40% range for Nifty options
  const avgIv = count > 0 ? ivSum / count : 15;
  const ivLevel = Math.max(0, Math.min(1, (avgIv - 10) / 30));

  const ivTrendNum = regime.ivTrend === "EXPANDING" ? 1 : regime.ivTrend === "COMPRESSING" ? 0 : 0.5;

  // Event ratios
  const total = events.length || 1;
  const churnRatio    = events.filter(e => e.type === "CHURN").length / total;
  const writingRatio  = events.filter(e => e.type === "FRESH_WRITING").length / total;
  const buildupRatio  = events.filter(e => e.type === "LONG_BUILDUP").length / total;
  const sweepRecent   = events.some(e => e.type === "LIQUIDITY_SWEEP") ? 1 : 0;

  const wallMigrationRecent = (walls.recentMigrations.length > 0 &&
    new Date().getTime() - new Date(walls.recentMigrations[0].timestamp).getTime() < 30 * 60 * 1000)
    ? 1 : 0;

  const breadthScore = regime.breadthScore;
  const coiEfficiency = count > 0 ? Math.min(1, effSum / count) : 0;

  // Distance from max pain: normalise over ±200 points
  const callWallStrike = walls.callWall?.strike ?? spot;
  const putWallStrike  = walls.putWall?.strike ?? spot;
  const maxPainApprox  = (callWallStrike + putWallStrike) / 2;
  const distFromMaxPain = Math.max(0, Math.min(1, 0.5 + (spot - maxPainApprox) / 400));

  return {
    callPutOiImbalance,
    ivLevel,
    ivTrend: ivTrendNum,
    breadthScore,
    coiEfficiency,
    wallMigrationRecent,
    churnRatio,
    writingRatio,
    buildupRatio,
    sweepRecent,
    distFromMaxPain,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COSINE SIMILARITY
// ─────────────────────────────────────────────────────────────────────────────

function toArray(v: FeatureVector): number[] {
  return [
    v.callPutOiImbalance,
    v.ivLevel,
    v.ivTrend,
    v.breadthScore,
    v.coiEfficiency,
    v.wallMigrationRecent,
    v.churnRatio,
    v.writingRatio,
    v.buildupRatio,
    v.sweepRecent,
    v.distFromMaxPain,
  ];
}

export function cosineSimilarity(a: FeatureVector, b: FeatureVector): number {
  const va = toArray(a);
  const vb = toArray(b);
  const dot = va.reduce((s, x, i) => s + x * vb[i], 0);
  const magA = Math.sqrt(va.reduce((s, x) => s + x * x, 0));
  const magB = Math.sqrt(vb.reduce((s, x) => s + x * x, 0));
  if (magA === 0 || magB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (magA * magB)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN CREATION FROM MOVE INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

let _patternIdCounter = 0;

export function createPatternFromMove(
  move: MoveInstance,
  featureVector: FeatureVector,
  wallNote: string,
  ivNote: string
): PrecursorPattern {
  return {
    id: `pat_${move.date.replace(/-/g, "")}_${++_patternIdCounter}`,
    moveDate: move.date,
    moveDirection: move.direction,
    moveMagnitude: move.magnitude,
    moveStartTs: move.startTs,
    featureVector,
    preMoveEventSequence: move.preMoveEventSequence,
    dominantStrikes: extractDominantStrikes(move),
    wallBehavior: wallNote,
    ivBehavior: ivNote,
    outcome: move.outcome,
    successCount: 0,
    failureCount: 0,
    reliabilityScore: 0.5,  // neutral prior
    lastSeen: move.date,
    avgMagnitude: move.magnitude,
    occurrenceCount: 1,
  };
}

function extractDominantStrikes(move: MoveInstance): number[] {
  // Use ATM at move start as proxy
  const atm = Math.round(move.spotAtStart / 50) * 50;
  return [atm - 100, atm, atm + 100];
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN MATCHING (live query)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find top N patterns most similar to the current live state.
 */
export function findPatternMatches(
  currentVector: FeatureVector,
  patterns: PrecursorPattern[],
  topN = 3
): PatternMatch[] {
  if (patterns.length === 0) return [];

  const scored = patterns.map(pattern => {
    const sim = cosineSimilarity(currentVector, pattern.featureVector);
    return { pattern, similarity: sim };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, topN).filter(s => s.similarity > 0.7);

  return top.map(({ pattern, similarity }) => {
    const reasons = buildMatchReasons(currentVector, pattern);
    const caveats = buildMatchCaveats(pattern);
    return { pattern, similarity, reasons, caveats };
  });
}

function buildMatchReasons(current: FeatureVector, p: PrecursorPattern): string[] {
  const reasons: string[] = [];
  const cv = current;
  const pv = p.featureVector;

  if (Math.abs(cv.ivTrend - pv.ivTrend) < 0.2) reasons.push("IV trend matches historical setup");
  if (Math.abs(cv.callPutOiImbalance - pv.callPutOiImbalance) < 0.15) reasons.push("Call/put OI balance similar");
  if (Math.abs(cv.breadthScore - pv.breadthScore) < 0.2) reasons.push("Conviction breadth matches");
  if (cv.wallMigrationRecent === pv.wallMigrationRecent) reasons.push("Wall migration state matches");
  if (Math.abs(cv.coiEfficiency - pv.coiEfficiency) < 0.2) reasons.push("COI efficiency level matches");
  if (p.preMoveEventSequence.includes("WALL_MIGRATION")) reasons.push("Prior setup had wall migration");
  if (p.preMoveEventSequence.includes("ABSORPTION")) reasons.push("Prior setup had absorption (hidden supply)");

  return reasons;
}

function buildMatchCaveats(p: PrecursorPattern): string[] {
  const caveats: string[] = [];
  if (p.reliabilityScore < 0.5) caveats.push(`Reliability low (${(p.reliabilityScore * 100).toFixed(0)}%) — more false positives historically`);
  if (p.occurrenceCount < 3) caveats.push("Limited occurrences — pattern not well established");
  const daysSince = (new Date().getTime() - new Date(p.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 30) caveats.push(`Last seen ${Math.round(daysSince)} days ago — may be stale`);
  if (p.outcome === "FAILED") caveats.push("Most recent outcome was a failed move — caution");
  return caveats;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELIABILITY UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a session ends, update pattern reliability based on outcome.
 */
export function updatePatternReliability(
  patterns: PrecursorPattern[],
  matchedPatternId: string,
  outcome: MoveInstance["outcome"]
): PrecursorPattern[] {
  return patterns.map(p => {
    if (p.id !== matchedPatternId) return p;

    const success = outcome === "SUSTAINED" || outcome === "PARTIAL";
    const updated: PrecursorPattern = {
      ...p,
      successCount: success ? p.successCount + 1 : p.successCount,
      failureCount: !success ? p.failureCount + 1 : p.failureCount,
      occurrenceCount: p.occurrenceCount + 1,
      lastSeen: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    const total = updated.successCount + updated.failureCount;
    updated.reliabilityScore = total > 0 ? updated.successCount / total : 0.5;
    return updated;
  });
}

/**
 * Prune patterns to MAX_PATTERNS, keeping highest reliability and most recent.
 */
export function prunePatterns(patterns: PrecursorPattern[]): PrecursorPattern[] {
  if (patterns.length <= MAX_PATTERNS) return patterns;

  // Score: reliability + recency bonus
  const now = new Date().getTime();
  const scored = patterns.map(p => {
    const ageDays = (now - new Date(p.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBonus = Math.max(0, 1 - ageDays / DECAY_DAYS);
    return { p, score: p.reliabilityScore * 0.7 + recencyBonus * 0.3 };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_PATTERNS).map(s => s.p);
}
