// ── Flow Intelligence Engine — Event Detection ────────────────────────────────
// Detects 11 event types from per-bar features.
// All logic is deterministic and auditable.

import type { BarFeatures, FlowEvent, FlowEventType, EventSide, EventSeverity } from "./types.js";
import { n } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let _eventCounter = 0;

function makeId(date: string, strike: number, type: FlowEventType, ts: string): string {
  // Use a short suffix to ensure uniqueness within the same bar
  return `${date.replace(/-/g, "")}_${strike}_${type}_${ts.slice(11, 16).replace(":", "")}`;
}

function severity(confidence: number): EventSeverity {
  if (confidence >= 80) return "CRITICAL";
  if (confidence >= 60) return "HIGH";
  if (confidence >= 40) return "MEDIUM";
  return "LOW";
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function todayIst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL EVENT DETECTORS
// Each returns a FlowEvent or null.
// ─────────────────────────────────────────────────────────────────────────────

function detectFreshWriting(f: BarFeatures, date: string): FlowEvent[] {
  const events: FlowEvent[] = [];

  // CALL side: OI↑, premium flat/falling, volume high
  if (
    f.callCoi > 50 &&
    f.zScoreCallCoi > 1.2 &&
    f.callPremRoc <= 2 &&         // premium not rising sharply
    f.callVol > 0
  ) {
    const score = clamp(
      50 +
      f.zScoreCallCoi * 10 +
      (f.callPremRoc < 0 ? 15 : 0) +
      (f.zScoreCallVol > 1 ? 10 : 0) +
      (f.callCoiAccel > 0 ? 10 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "FRESH_WRITING", f.timestamp),
        date, timestamp: f.timestamp, strike: f.strike,
        type: "FRESH_WRITING", side: "CALL",
        confidence: score,
        severity: severity(score),
        explanation: `Call writing detected at ${f.strike}. OI added ${f.callCoi > 0 ? "+" : ""}${f.callCoi.toFixed(0)} contracts while premium ${f.callPremRoc >= 0 ? "held flat" : "fell ₹" + Math.abs(f.callPremRoc).toFixed(1)}, suggesting sellers creating resistance.`,
        features: { coiChange: f.callCoi, volDelta: f.callVol, premiumChange: f.callPremRoc, zScore: f.zScoreCallCoi },
      });
    }
  }

  // PUT side: OI↑, premium flat/falling
  if (
    f.putCoi > 50 &&
    f.zScorePutCoi > 1.2 &&
    f.putPremRoc <= 2 &&
    f.putVol > 0
  ) {
    const score = clamp(
      50 +
      f.zScorePutCoi * 10 +
      (f.putPremRoc < 0 ? 15 : 0) +
      (f.zScorePutVol > 1 ? 10 : 0) +
      (f.putCoiAccel > 0 ? 10 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "FRESH_WRITING", f.timestamp) + "_P",
        date, timestamp: f.timestamp, strike: f.strike,
        type: "FRESH_WRITING", side: "PUT",
        confidence: score,
        severity: severity(score),
        explanation: `Put writing at ${f.strike}. ${f.putCoi.toFixed(0)} contracts added while premium ${f.putPremRoc >= 0 ? "stayed flat" : "fell ₹" + Math.abs(f.putPremRoc).toFixed(1)}. Suggests support floor being built at this strike.`,
        features: { coiChange: f.putCoi, volDelta: f.putVol, premiumChange: f.putPremRoc, zScore: f.zScorePutCoi },
      });
    }
  }

  return events;
}

function detectShortCovering(f: BarFeatures, date: string): FlowEvent[] {
  const events: FlowEvent[] = [];

  // CALL short cover: OI↓, premium↑ (shorts getting squeezed out)
  if (
    f.callCoi < -50 &&
    f.zScoreCallCoi < -1.0 &&
    f.callPremRoc > 0 &&
    f.callVol > 0
  ) {
    const score = clamp(
      50 +
      Math.abs(f.zScoreCallCoi) * 8 +
      (f.callPremRoc > 3 ? 15 : f.callPremRoc > 1 ? 8 : 0) +
      (f.zScoreCallVol > 1 ? 10 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "SHORT_COVERING", f.timestamp),
        date, timestamp: f.timestamp, strike: f.strike,
        type: "SHORT_COVERING", side: "CALL",
        confidence: score,
        severity: severity(score),
        explanation: `Call short covering at ${f.strike}. OI fell ${f.callCoi.toFixed(0)} contracts as premium rose ₹${f.callPremRoc.toFixed(1)} — shorts exiting rapidly, bullish signal.`,
        features: { coiChange: f.callCoi, premiumChange: f.callPremRoc, zScore: f.zScoreCallCoi },
      });
    }
  }

  // PUT short cover: OI↓, premium↑
  if (
    f.putCoi < -50 &&
    f.zScorePutCoi < -1.0 &&
    f.putPremRoc > 0 &&
    f.putVol > 0
  ) {
    const score = clamp(
      50 +
      Math.abs(f.zScorePutCoi) * 8 +
      (f.putPremRoc > 3 ? 15 : f.putPremRoc > 1 ? 8 : 0) +
      (f.zScorePutVol > 1 ? 10 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "SHORT_COVERING", f.timestamp) + "_P",
        date, timestamp: f.timestamp, strike: f.strike,
        type: "SHORT_COVERING", side: "PUT",
        confidence: score,
        severity: severity(score),
        explanation: `Put short covering at ${f.strike}. OI fell ${f.putCoi.toFixed(0)} while premium rose ₹${f.putPremRoc.toFixed(1)} — hedges unwound, bearish signal.`,
        features: { coiChange: f.putCoi, premiumChange: f.putPremRoc, zScore: f.zScorePutCoi },
      });
    }
  }

  return events;
}

function detectLongBuildup(f: BarFeatures, date: string): FlowEvent[] {
  const events: FlowEvent[] = [];

  // CALL long buildup: OI↑, premium↑ (fresh buyers entering)
  if (
    f.callCoi > 50 &&
    f.zScoreCallCoi > 1.0 &&
    f.callPremRoc > 1 &&
    f.callPremMomentum > 0  // sustained premium rise
  ) {
    const score = clamp(
      45 +
      f.zScoreCallCoi * 8 +
      (f.callPremRoc > 5 ? 20 : f.callPremRoc > 2 ? 10 : 5) +
      (f.callPremMomentum > 3 ? 10 : 0) +
      (f.callCoiAccel > 0 ? 8 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "LONG_BUILDUP", f.timestamp),
        date, timestamp: f.timestamp, strike: f.strike,
        type: "LONG_BUILDUP", side: "CALL",
        confidence: score,
        severity: severity(score),
        explanation: `Call long buildup at ${f.strike}. ${f.callCoi.toFixed(0)} OI added with premium rising ₹${f.callPremRoc.toFixed(1)} — fresh buyers entering at this strike.`,
        features: { coiChange: f.callCoi, premiumChange: f.callPremRoc, zScore: f.zScoreCallCoi, premiumMomentum: f.callPremMomentum },
      });
    }
  }

  // PUT long buildup
  if (
    f.putCoi > 50 &&
    f.zScorePutCoi > 1.0 &&
    f.putPremRoc > 1 &&
    f.putPremMomentum > 0
  ) {
    const score = clamp(
      45 +
      f.zScorePutCoi * 8 +
      (f.putPremRoc > 5 ? 20 : f.putPremRoc > 2 ? 10 : 5) +
      (f.putPremMomentum > 3 ? 10 : 0) +
      (f.putCoiAccel > 0 ? 8 : 0)
    );
    if (score >= 40) {
      events.push({
        id: makeId(date, f.strike, "LONG_BUILDUP", f.timestamp) + "_P",
        date, timestamp: f.timestamp, strike: f.strike,
        type: "LONG_BUILDUP", side: "PUT",
        confidence: score,
        severity: severity(score),
        explanation: `Put long buildup at ${f.strike}. ${f.putCoi.toFixed(0)} OI added with premium rising ₹${f.putPremRoc.toFixed(1)} — fresh put buyers, bearish signal.`,
        features: { coiChange: f.putCoi, premiumChange: f.putPremRoc, zScore: f.zScorePutCoi },
      });
    }
  }

  return events;
}

function detectLongUnwinding(f: BarFeatures, date: string): FlowEvent[] {
  const events: FlowEvent[] = [];

  // CALL long unwind: OI↓, premium↓
  if (
    f.callCoi < -30 &&
    f.callPremRoc < -1 &&
    f.callPremMomentum < 0
  ) {
    const score = clamp(
      40 +
      Math.abs(f.zScoreCallCoi) * 7 +
      (f.callPremRoc < -5 ? 15 : f.callPremRoc < -2 ? 8 : 3) +
      (f.callPremMomentum < -3 ? 10 : 0)
    );
    if (score >= 35) {
      events.push({
        id: makeId(date, f.strike, "LONG_UNWINDING", f.timestamp),
        date, timestamp: f.timestamp, strike: f.strike,
        type: "LONG_UNWINDING", side: "CALL",
        confidence: score,
        severity: severity(score),
        explanation: `Call long unwinding at ${f.strike}. OI fell ${f.callCoi.toFixed(0)} as premium dropped ₹${Math.abs(f.callPremRoc).toFixed(1)} — longs exiting, bearish signal.`,
        features: { coiChange: f.callCoi, premiumChange: f.callPremRoc, zScore: f.zScoreCallCoi },
      });
    }
  }

  // PUT long unwind: OI↓, premium↓
  if (
    f.putCoi < -30 &&
    f.putPremRoc < -1 &&
    f.putPremMomentum < 0
  ) {
    const score = clamp(
      40 +
      Math.abs(f.zScorePutCoi) * 7 +
      (f.putPremRoc < -5 ? 15 : f.putPremRoc < -2 ? 8 : 3) +
      (f.putPremMomentum < -3 ? 10 : 0)
    );
    if (score >= 35) {
      events.push({
        id: makeId(date, f.strike, "LONG_UNWINDING", f.timestamp) + "_P",
        date, timestamp: f.timestamp, strike: f.strike,
        type: "LONG_UNWINDING", side: "PUT",
        confidence: score,
        severity: severity(score),
        explanation: `Put long unwinding at ${f.strike}. OI fell ${f.putCoi.toFixed(0)} as premium dropped ₹${Math.abs(f.putPremRoc).toFixed(1)} — put longs exiting, bullish signal.`,
        features: { coiChange: f.putCoi, premiumChange: f.putPremRoc, zScore: f.zScorePutCoi },
      });
    }
  }

  return events;
}

function detectChurn(f: BarFeatures, date: string): FlowEvent | null {
  // High volume but low net COI — back-and-forth, no conviction
  const totalVol = f.callVol + f.putVol;
  const totalAbsCoi = Math.abs(f.callCoi) + Math.abs(f.putCoi);
  if (totalVol < 200) return null; // not enough volume to call it churn

  const efficiency = totalVol > 0 ? totalAbsCoi / totalVol : 0;
  const isHighVol = f.zScoreCallVol > 1.2 || f.zScorePutVol > 1.2;

  if (efficiency < 0.25 && isHighVol) {
    const score = clamp(40 + (1 - efficiency) * 30 + (isHighVol ? 15 : 0));
    return {
      id: makeId(date, f.strike, "CHURN", f.timestamp),
      date, timestamp: f.timestamp, strike: f.strike,
      type: "CHURN", side: "BOTH",
      confidence: score,
      severity: severity(score),
      explanation: `High volume churn at ${f.strike}. ${totalVol.toFixed(0)} total contracts traded but only ${(efficiency * 100).toFixed(0)}% converted to net OI — indecision, no conviction.`,
      features: { volDelta: totalVol, coiChange: totalAbsCoi, efficiency },
    };
  }
  return null;
}

function detectWallCreation(
  f: BarFeatures,
  allFeatures: Map<number, BarFeatures>,
  date: string
): FlowEvent[] {
  const events: FlowEvent[] = [];
  // A strike has a WALL if its OI is exceptionally high vs nearby strikes
  const nearbyOis: number[] = [];
  allFeatures.forEach(nf => {
    if (Math.abs(nf.strike - f.strike) <= 300 && nf.strike !== f.strike) {
      nearbyOis.push(n(nf.callLtp) > 0 ? nf.callCoi : 0); // just collect neighborhood
    }
  });

  // Use OI values stored in the bar itself
  const callOi = n(f.callLtp) >= 0 ? n((allFeatures.get(f.strike) as any)?.callLtp ?? 0) : 0;
  // Actually, let's use the raw OI from bar since BarFeatures has callLtp not callOi
  // Wall creation uses: large absolute OI + positive COI (replenishment) + above P90 OI
  // We approximate using zScore of COI + positive COI + ATM proximity
  const callIsWall =
    f.callCoi > 200 &&
    f.zScoreCallCoi > 2.0 &&
    (f.moneyness === "ATM" || f.moneyness === "NEAR" || f.moneyness === "OTM");

  const putIsWall =
    f.putCoi > 200 &&
    f.zScorePutCoi > 2.0 &&
    (f.moneyness === "ATM" || f.moneyness === "NEAR" || f.moneyness === "OTM");

  if (callIsWall) {
    const score = clamp(55 + f.zScoreCallCoi * 8);
    events.push({
      id: makeId(date, f.strike, "WALL_CREATION", f.timestamp),
      date, timestamp: f.timestamp, strike: f.strike,
      type: "WALL_CREATION", side: "CALL",
      confidence: score,
      severity: severity(score),
      explanation: `Call wall building at ${f.strike}. Exceptional OI addition (+${f.callCoi.toFixed(0)}) — institutional resistance ceiling being established.`,
      features: { coiChange: f.callCoi, zScore: f.zScoreCallCoi },
    });
  }

  if (putIsWall) {
    const score = clamp(55 + f.zScorePutCoi * 8);
    events.push({
      id: makeId(date, f.strike, "WALL_CREATION", f.timestamp) + "_P",
      date, timestamp: f.timestamp, strike: f.strike,
      type: "WALL_CREATION", side: "PUT",
      confidence: score,
      severity: severity(score),
      explanation: `Put wall building at ${f.strike}. Exceptional OI addition (+${f.putCoi.toFixed(0)}) — institutional support floor being established.`,
      features: { coiChange: f.putCoi, zScore: f.zScorePutCoi },
    });
  }

  return events;
}

function detectIvShock(f: BarFeatures, date: string): FlowEvent | null {
  // Either call or put IV jumping abnormally
  const callShock = Math.abs(f.zScoreCallIvRoc) > 2.5 && Math.abs(f.callIvRoc) > 0.5;
  const putShock  = Math.abs(f.zScorePutIvRoc)  > 2.5 && Math.abs(f.putIvRoc)  > 0.5;

  if (!callShock && !putShock) return null;

  const side: EventSide = callShock && putShock ? "BOTH" : callShock ? "CALL" : "PUT";
  const ivChange = callShock ? f.callIvRoc : f.putIvRoc;
  const ivDir = ivChange > 0 ? "spike" : "collapse";
  const score = clamp(50 + Math.max(Math.abs(f.zScoreCallIvRoc), Math.abs(f.zScorePutIvRoc)) * 10);

  return {
    id: makeId(date, f.strike, "IV_SHOCK", f.timestamp),
    date, timestamp: f.timestamp, strike: f.strike,
    type: "IV_SHOCK", side,
    confidence: score,
    severity: severity(score),
    explanation: `IV ${ivDir} at ${f.strike}. ${side === "BOTH" ? "Both call and put IVs" : side === "CALL" ? "Call IV" : "Put IV"} moved ${Math.abs(ivChange).toFixed(2)}% abnormally vs recent history.`,
    features: { ivChange: callShock ? f.callIvRoc : f.putIvRoc, zScore: Math.max(Math.abs(f.zScoreCallIvRoc), Math.abs(f.zScorePutIvRoc)) },
  };
}

function detectExpiryPin(
  f: BarFeatures,
  spot: number,
  maxPainStrike: number | null,
  daysToExpiry: number,
  date: string
): FlowEvent | null {
  if (maxPainStrike === null || daysToExpiry > 2) return null;
  if (Math.abs(spot - maxPainStrike) > 100) return null;

  // Expiry pin: spot near max pain + very low premium (both call + put ltp are small)
  const atmCallCheap = f.callLtp < 15 && f.moneyness === "ATM";
  const atmPutCheap  = f.putLtp  < 15 && f.moneyness === "ATM";

  if (!atmCallCheap && !atmPutCheap) return null;

  const distToPin = Math.abs(spot - maxPainStrike);
  const score = clamp(65 + (100 - distToPin) / 3 + (daysToExpiry === 0 ? 20 : 5));

  return {
    id: makeId(date, f.strike, "EXPIRY_PIN", f.timestamp),
    date, timestamp: f.timestamp, strike: f.strike,
    type: "EXPIRY_PIN", side: "BOTH",
    confidence: score,
    severity: severity(score),
    explanation: `Expiry pin behaviour at ${maxPainStrike}. Spot is ${distToPin.toFixed(0)} pts from max pain with ${daysToExpiry === 0 ? "same-day" : daysToExpiry + "-day"} expiry. Low premiums suggest writers defending the pin.`,
    features: { distFromMaxPain: distToPin, daysToExpiry, callLtp: f.callLtp, putLtp: f.putLtp },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-BAR DETECTORS (need prior bar context)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liquidity sweep: sudden burst followed by reversal within 2-3 bars.
 * Requires 3+ bars for the current strike.
 */
function detectLiquiditySweep(
  f: BarFeatures,
  bars: any[], // newest-first
  date: string
): FlowEvent | null {
  if (bars.length < 3) return null;

  const b0 = bars[0], b1 = bars[1], b2 = bars[2];

  const coi0 = n(b0.call?.coi), coi1 = n(b1.call?.coi), coi2 = n(b2.call?.coi);
  const pr0  = n(b0.call?.premiumRoc), pr1 = n(b1.call?.premiumRoc);
  const vol1 = n(b1.call?.volDelta);

  // Call sweep: prior bar had large positive COI + high vol, current bar reverses
  const callSweep =
    Math.abs(coi1) > 150 &&      // prior bar had large OI move
    vol1 > 200 &&                 // prior bar had high volume
    Math.sign(coi0) !== 0 &&
    Math.sign(coi0) !== Math.sign(coi1) && // current bar reverses direction
    Math.abs(coi0) > 50;         // reversal is meaningful

  const putCoi0 = n(b0.put?.coi), putCoi1 = n(b1.put?.coi);
  const putVol1 = n(b1.put?.volDelta);
  const putSweep =
    Math.abs(putCoi1) > 150 &&
    putVol1 > 200 &&
    Math.sign(putCoi0) !== 0 &&
    Math.sign(putCoi0) !== Math.sign(putCoi1) &&
    Math.abs(putCoi0) > 50;

  if (!callSweep && !putSweep) return null;

  const side: EventSide = callSweep && putSweep ? "BOTH" : callSweep ? "CALL" : "PUT";
  const score = clamp(55 + (callSweep ? f.zScoreCallVol : f.zScorePutVol) * 8);

  return {
    id: makeId(date, f.strike, "LIQUIDITY_SWEEP", f.timestamp),
    date, timestamp: f.timestamp, strike: f.strike,
    type: "LIQUIDITY_SWEEP", side,
    confidence: score,
    severity: severity(score),
    explanation: `Possible liquidity sweep at ${f.strike}. Large ${side.toLowerCase()} OI burst followed by rapid reversal — likely institutional trap or aggressive stop-hunting.`,
    features: { coiChange: callSweep ? coi1 : putCoi1, volDelta: callSweep ? vol1 : putVol1 },
  };
}

/**
 * Absorption: heavy activity (high vol, high COI) but premium doesn't move proportionally.
 * Expected: high z-score vol AND high z-score COI BUT low premium response.
 */
function detectAbsorption(f: BarFeatures, date: string): FlowEvent | null {
  const callAbsorb =
    f.zScoreCallCoi > 1.5 &&
    f.zScoreCallVol > 1.5 &&
    Math.abs(f.callPremRoc) < 2 &&  // expected move didn't happen
    f.callCoi > 100;

  const putAbsorb =
    f.zScorePutCoi > 1.5 &&
    f.zScorePutVol > 1.5 &&
    Math.abs(f.putPremRoc) < 2 &&
    f.putCoi > 100;

  if (!callAbsorb && !putAbsorb) return null;

  const side: EventSide = callAbsorb && putAbsorb ? "BOTH" : callAbsorb ? "CALL" : "PUT";
  const score = clamp(50 + Math.max(f.zScoreCallCoi, f.zScorePutCoi) * 7);

  return {
    id: makeId(date, f.strike, "ABSORPTION", f.timestamp),
    date, timestamp: f.timestamp, strike: f.strike,
    type: "ABSORPTION", side,
    confidence: score,
    severity: severity(score),
    explanation: `Absorption at ${f.strike}. Heavy ${side.toLowerCase()} flow (OI + volume both elevated) but premium barely moved — large player absorbing supply, potential breakout suppression.`,
    features: {
      coiChange: callAbsorb ? f.callCoi : f.putCoi,
      volDelta: callAbsorb ? f.callVol : f.putVol,
      premiumChange: callAbsorb ? f.callPremRoc : f.putPremRoc,
      efficiency: callAbsorb ? f.callCoiEfficiency : f.putCoiEfficiency,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EVENT DETECTION ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export interface EventDetectionContext {
  allFeatures: Map<number, BarFeatures>;
  spot: number;
  maxPainStrike: number | null;
  daysToExpiry: number;
  date: string;
}

/**
 * Detect all events for a single strike.
 * @param strike - The strike price
 * @param features - Pre-computed BarFeatures for this bar
 * @param bars - Raw timeline bars for this strike (newest-first), for multi-bar detectors
 * @param ctx - Session context (other strikes, expiry info)
 */
export function detectEventsForStrike(
  features: BarFeatures,
  bars: any[],
  ctx: EventDetectionContext
): FlowEvent[] {
  const { date } = ctx;
  const events: FlowEvent[] = [];

  // Single-bar detectors
  events.push(...detectFreshWriting(features, date));
  events.push(...detectShortCovering(features, date));
  events.push(...detectLongBuildup(features, date));
  events.push(...detectLongUnwinding(features, date));

  const churn = detectChurn(features, date);
  if (churn) events.push(churn);

  events.push(...detectWallCreation(features, ctx.allFeatures, date));

  const ivShock = detectIvShock(features, date);
  if (ivShock) events.push(ivShock);

  const pin = detectExpiryPin(features, ctx.spot, ctx.maxPainStrike, ctx.daysToExpiry, date);
  if (pin) events.push(pin);

  // Multi-bar detectors
  const sweep = detectLiquiditySweep(features, bars, date);
  if (sweep) events.push(sweep);

  const absorb = detectAbsorption(features, date);
  if (absorb) events.push(absorb);

  // Filter to minimum confidence threshold
  return events.filter(e => e.confidence >= 35);
}

// ─────────────────────────────────────────────────────────────────────────────
// ANOMALY SCORING
// ─────────────────────────────────────────────────────────────────────────────

import type { AnomalyEntry } from "./types.js";

/**
 * Compute a composite anomaly score for each strike based on z-scores.
 * Returns top N by score, descending.
 */
export function computeAnomalies(
  allFeatures: Map<number, BarFeatures>,
  recentEvents: FlowEvent[],
  topN = 10
): AnomalyEntry[] {
  const results: AnomalyEntry[] = [];

  allFeatures.forEach(f => {
    // Composite score: max of all z-scores weighted by importance
    const callAnomaly = Math.max(
      Math.abs(f.zScoreCallCoi),
      Math.abs(f.zScoreCallVol),
      Math.abs(f.zScoreCallIvRoc) * 0.7,
    );
    const putAnomaly = Math.max(
      Math.abs(f.zScorePutCoi),
      Math.abs(f.zScorePutVol),
      Math.abs(f.zScorePutIvRoc) * 0.7,
    );
    const score = Math.min(100, (callAnomaly + putAnomaly) * 15);
    if (score < 20) return;

    // Find most recent event for this strike
    const strikeEvents = recentEvents.filter(e => e.strike === f.strike);
    const dominant = strikeEvents.sort((a, b) => b.confidence - a.confidence)[0];

    results.push({
      strike: f.strike,
      anomalyScore: Math.round(score),
      dominantType: dominant?.type ?? "CHURN",
      confidence: dominant?.confidence ?? Math.round(score),
      explanation: dominant?.explanation ?? `Unusual activity at ${f.strike} (z-score: ${Math.max(callAnomaly, putAnomaly).toFixed(1)})`,
      callZScore: Math.round(callAnomaly * 10) / 10,
      putZScore: Math.round(putAnomaly * 10) / 10,
    });
  });

  return results.sort((a, b) => b.anomalyScore - a.anomalyScore).slice(0, topN);
}
