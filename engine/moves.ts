// ── Flow Intelligence Engine — Large Move Detection + Start Inference ─────────
// Detects significant price moves and infers their structural start point.

import type {
  MoveInstance, MoveDirection, MoveOutcome, PreMoveWindow, FlowEvent, FlowEventType, BarFeatures,
} from "./types.js";
import { n } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

export const MOVE_CONFIG = {
  MIN_POINTS: 40,           // minimum Nifty point move to qualify
  MAX_BARS: 10,             // move must complete within 10 bars (30 min)
  ATR_MULTIPLE: 2.0,        // or 2.0× rolling 14-bar ATR
  MIN_LOOKBACK_BARS: 5,     // minimum bars of history needed
  PRE_MOVE_WINDOWS: [30, 15, 9, 6, 3] as const, // minutes before move
};

// ─────────────────────────────────────────────────────────────────────────────
// SPOT PRICE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

interface SpotBar {
  timestamp: string;   // ISO
  spot: number;
}

/**
 * Extract a chronological spot price history from timelineStore.
 * Uses a single reference strike (or ATM) to get spot values.
 */
export function extractSpotHistory(timelineStore: Map<number, any[]>): SpotBar[] {
  // Collect all unique bars across all strikes, keyed by isoTimestamp
  const byTs = new Map<string, number>();

  timelineStore.forEach((bars) => {
    for (const bar of bars) {
      if (!bar.isoTimestamp) continue;
      const spotVal = n(bar.spot);
      if (spotVal > 0 && !byTs.has(bar.isoTimestamp)) {
        byTs.set(bar.isoTimestamp, spotVal);
      }
    }
  });

  return Array.from(byTs.entries())
    .map(([ts, spot]) => ({ timestamp: ts, spot }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ─────────────────────────────────────────────────────────────────────────────
// ATR COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

function computeAtr(spots: number[], period = 14): number[] {
  const atrs: number[] = [];
  for (let i = 0; i < spots.length; i++) {
    if (i < period) { atrs.push(0); continue; }
    const window = spots.slice(i - period, i);
    const ranges = window.map((s, j) => j === 0 ? 0 : Math.abs(s - window[j - 1]));
    atrs.push(ranges.reduce((a, b) => a + b, 0) / period);
  }
  return atrs;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

interface RawMove {
  startIdx: number;
  peakIdx: number;
  direction: MoveDirection;
  magnitude: number;
  startTs: string;
  peakTs: string;
  spotAtStart: number;
  spotAtPeak: number;
}

/**
 * Scan spot history for large moves meeting the configured thresholds.
 * Returns detected moves, most recent first.
 */
export function detectLargeMoves(spotBars: SpotBar[]): RawMove[] {
  if (spotBars.length < MOVE_CONFIG.MIN_LOOKBACK_BARS) return [];

  const spots = spotBars.map(b => b.spot);
  const atrs   = computeAtr(spots);
  const moves: RawMove[] = [];

  for (let i = MOVE_CONFIG.MIN_LOOKBACK_BARS; i < spots.length; i++) {
    for (let j = Math.max(0, i - MOVE_CONFIG.MAX_BARS); j < i; j++) {
      const delta = spots[i] - spots[j];
      const absDelta = Math.abs(delta);
      const atr = atrs[i] || 10;
      const threshold = Math.max(MOVE_CONFIG.MIN_POINTS, atr * MOVE_CONFIG.ATR_MULTIPLE);

      if (absDelta >= threshold) {
        const direction: MoveDirection = delta > 0 ? "UP" : "DOWN";
        // Avoid duplicate overlapping moves
        const overlaps = moves.some(m =>
          (m.startIdx <= i && m.peakIdx >= j) ||
          Math.abs(m.startIdx - j) <= 2
        );
        if (!overlaps) {
          moves.push({
            startIdx: j,
            peakIdx: i,
            direction,
            magnitude: absDelta,
            startTs: spotBars[j].timestamp,
            peakTs: spotBars[i].timestamp,
            spotAtStart: spots[j],
            spotAtPeak: spots[i],
          });
        }
      }
    }
  }

  // Sort by recency
  return moves.sort((a, b) => b.peakIdx - a.peakIdx);
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVE-START INFERENCE (structural break logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk backward from the move's price-expansion start to find the earliest
 * structural signal: IV shift, wall migration, COI efficiency change, or anomaly cluster.
 *
 * @param move - Raw detected move
 * @param spotBars - Chronological spot bars
 * @param events - All flow events from the same date
 * @param allFeatures - Map<strike, BarFeatures> at the time of the move
 * @returns Adjusted startTs (may be earlier than the price-based start)
 */
export function inferMoveStart(
  move: RawMove,
  spotBars: SpotBar[],
  events: FlowEvent[],
  allFeatures: Map<number, BarFeatures>
): string {
  const moveStartTs = move.startTs;

  // Look back up to 15 bars before the move price start
  const lookbackMs = 15 * 3 * 60 * 1000; // 45 min
  const moveStartMs = new Date(moveStartTs).getTime();
  const lookbackStart = new Date(moveStartMs - lookbackMs).toISOString();

  // Events before the move start
  const priorEvents = events.filter(e =>
    e.timestamp >= lookbackStart && e.timestamp < moveStartTs
  );

  if (priorEvents.length === 0) return moveStartTs;

  // Scoring function: each type of pre-move signal earns points
  const scoredTimestamps: Array<{ ts: string; score: number }> = [];

  // Group events by timestamp bucket (3-min bars)
  const eventsByBucket = new Map<string, FlowEvent[]>();
  for (const e of priorEvents) {
    const bucket = e.timestamp.slice(0, 15); // YYYY-MM-DDTHH:MM
    if (!eventsByBucket.has(bucket)) eventsByBucket.set(bucket, []);
    eventsByBucket.get(bucket)!.push(e);
  }

  eventsByBucket.forEach((bucketEvents, bucket) => {
    let score = 0;
    const types = bucketEvents.map(e => e.type);

    // IV shift = strong precursor
    if (types.includes("IV_SHOCK")) score += 30;
    // Wall migration = repositioning
    if (types.includes("WALL_MIGRATION")) score += 25;
    // High efficiency (directional conviction emerging)
    const hasHighEff = bucketEvents.some(e => (e.features?.efficiency ?? 0) > 0.5);
    if (hasHighEff) score += 20;
    // Anomaly cluster: 3+ strikes showing same event type
    const typeCounts: Record<string, number> = {};
    for (const e of bucketEvents) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    const maxCount = Math.max(...Object.values(typeCounts));
    if (maxCount >= 3) score += 25;
    // Writing OR long buildup (directional positioning)
    if (types.includes("FRESH_WRITING") || types.includes("LONG_BUILDUP")) score += 15;
    // Absorption before move = hidden supply being absorbed
    if (types.includes("ABSORPTION")) score += 20;

    if (score > 0) scoredTimestamps.push({ ts: bucket + ":00.000Z", score });
  });

  if (scoredTimestamps.length === 0) return moveStartTs;

  // Use earliest high-scoring bar (> threshold) as structural start
  const threshold = 30;
  const candidates = scoredTimestamps
    .filter(x => x.score >= threshold)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  return candidates.length > 0 ? candidates[0].ts : moveStartTs;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-MOVE WINDOW EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract feature snapshots at T-30, T-15, T-9, T-6, T-3 minutes before move start.
 */
export function extractPreMoveWindows(
  moveStartTs: string,
  events: FlowEvent[],
  allFeatures: Map<number, BarFeatures>,
  spotBars: SpotBar[],
  spot: number
): PreMoveWindow[] {
  const windows: PreMoveWindow[] = [];
  const moveStartMs = new Date(moveStartTs).getTime();

  for (const minutesBefore of MOVE_CONFIG.PRE_MOVE_WINDOWS) {
    const windowMs = moveStartMs - minutesBefore * 60 * 1000;
    const windowTs = new Date(windowMs).toISOString();
    const windowTsEnd = new Date(windowMs + 3 * 60 * 1000).toISOString();

    // Events in this 3-min window
    const windowEvents = events.filter(e =>
      e.timestamp >= windowTs && e.timestamp < windowTsEnd
    );

    // Spot at this window
    const nearestSpotBar = spotBars
      .filter(b => b.timestamp <= windowTsEnd)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    const spotAtWindow = nearestSpotBar?.spot ?? spot;

    // ATM ± 200 features
    const atm = Math.round(spotAtWindow / 50) * 50;
    let callOiChange = 0, putOiChange = 0, callVolume = 0, putVolume = 0;
    let ivSum = 0, effSum = 0, strikeCount = 0;

    allFeatures.forEach((f, strike) => {
      if (Math.abs(strike - atm) > 200) return;
      callOiChange += f.callCoi;
      putOiChange  += f.putCoi;
      callVolume   += f.callVol;
      putVolume    += f.putVol;
      ivSum        += (f.callIv + f.putIv) / 2;
      effSum       += (f.callCoiEfficiency + f.putCoiEfficiency) / 2;
      strikeCount++;
    });

    const coveredStrikes = allFeatures.size;
    const activeStrikes = windowEvents.length;
    const breadth = coveredStrikes > 0 ? activeStrikes / coveredStrikes : 0;

    // Dominant event in this window
    const dominantEventType = windowEvents.length > 0
      ? windowEvents.sort((a, b) => b.confidence - a.confidence)[0].type
      : null;

    // Anomaly score: mean z-score in this window
    const avgConf = windowEvents.length > 0
      ? windowEvents.reduce((s, e) => s + e.confidence, 0) / windowEvents.length
      : 0;

    windows.push({
      windowLabel: `T-${minutesBefore}`,
      timestamp: windowTs,
      spotAtWindow,
      callOiChange,
      putOiChange,
      callVolume,
      putVolume,
      ivLevel: strikeCount > 0 ? ivSum / strikeCount : 0,
      coiEfficiency: strikeCount > 0 ? effSum / strikeCount : 0,
      breadth,
      dominantEvent: dominantEventType,
      anomalyScore: Math.min(100, avgConf),
    });
  }

  return windows;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD MOVE INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

let _moveIdCounter = 0;

export function buildMoveInstance(
  move: RawMove,
  inferredStartTs: string,
  preMoveWindows: PreMoveWindow[],
  events: FlowEvent[],
  wallNote: string,
  ivNote: string,
  date: string
): MoveInstance {
  // Pre-move event sequence (events in the 30 min before inferred start)
  const lookbackStart = new Date(
    new Date(inferredStartTs).getTime() - 30 * 60 * 1000
  ).toISOString();
  const preMoveEvents = events
    .filter(e => e.timestamp >= lookbackStart && e.timestamp <= inferredStartTs)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(e => e.type);
  // Deduplicate consecutive same types
  const sequence = preMoveEvents.filter((t, i) => i === 0 || t !== preMoveEvents[i - 1]);

  return {
    id: `move_${date.replace(/-/g, "")}_${++_moveIdCounter}`,
    date,
    direction: move.direction,
    magnitude: Math.round(move.magnitude),
    startTs: inferredStartTs,
    triggerTs: move.startTs,
    peakTs: move.peakTs,
    spotAtStart: move.spotAtStart,
    spotAtPeak: move.spotAtPeak,
    preMoveWindows,
    preMoveEventSequence: sequence as FlowEventType[],
    wallBehaviorNote: wallNote,
    ivBehaviorNote: ivNote,
    outcome: "PENDING",
    confidence: Math.min(90, 50 + (sequence.length > 3 ? 20 : 10) + (preMoveWindows.some(w => w.anomalyScore > 60) ? 20 : 0)),
  };
}
