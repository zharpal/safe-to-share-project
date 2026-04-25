// ── Flow Intelligence Engine — Per-Bar Feature Computation ───────────────────
// Pure functions. No I/O. Takes raw timeline bars (newest-first) and returns
// computed features for the most recent bar.

import type { BarFeatures, Moneyness } from "./types.js";
import { n } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Classify a strike's distance from spot into a moneyness bucket. */
export function moneyness(strike: number, spot: number): Moneyness {
  const dist = Math.abs(strike - spot);
  if (dist < 50)  return "ATM";
  if (dist < 150) return "NEAR";
  if (dist < 350) return "OTM";
  return "FAR_OTM";
}

/** Rolling mean of an array (first N elements). */
function mean(arr: number[], n = 20): number {
  const w = arr.slice(0, n);
  if (w.length === 0) return 0;
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/** Rolling std-dev of an array (first N elements). */
function std(arr: number[], n = 20): number {
  const w = arr.slice(0, n);
  if (w.length < 2) return 1; // avoid div-by-zero
  const m = mean(w);
  const variance = w.map(x => (x - m) ** 2).reduce((a, b) => a + b, 0) / w.length;
  return Math.sqrt(variance) || 1;
}

/** Z-score of value against history (first N elements). Returns 0 if < 5 data points. */
export function zScore(value: number, history: number[], windowSize = 20): number {
  const w = history.slice(0, windowSize);
  if (w.length < 5) return 0;
  const m = mean(w);
  const s = std(w);
  return (value - m) / s;
}

/** Running sum of last N values. */
function sumLast(arr: number[], n: number): number {
  return arr.slice(0, n).reduce((a, b) => a + b, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FEATURE EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute BarFeatures for the most recent bar of a strike.
 *
 * @param strike  - Strike price
 * @param bars    - Timeline bars, NEWEST-FIRST (as stored in timelineStore)
 * @param spot    - Current spot price (Nifty 50)
 * @returns       BarFeatures or null if fewer than 1 bar
 */
export function computeBarFeatures(
  strike: number,
  bars: any[],
  spot: number
): BarFeatures | null {
  if (bars.length === 0) return null;

  const bar = bars[0]; // most recent
  const spotN = spot || n(bar.spot);

  // ── Numeric values ────────────────────────────────────────────────────────
  const callCoi     = n(bar.call?.coi);
  const putCoi      = n(bar.put?.coi);
  const callVol     = n(bar.call?.volDelta);
  const putVol      = n(bar.put?.volDelta);
  const callIv      = n(bar.call?.iv);
  const putIv       = n(bar.put?.iv);
  const callIvRoc   = n(bar.call?.ivRoc);
  const putIvRoc    = n(bar.put?.ivRoc);
  const callLtp     = n(bar.call?.ltp);
  const putLtp      = n(bar.put?.ltp);
  const callPremRoc = n(bar.call?.premiumRoc);
  const putPremRoc  = n(bar.put?.premiumRoc);

  // ── Historical arrays (for rolling stats) ────────────────────────────────
  // bars is newest-first, so bars[0] = now, bars[1] = prior, etc.
  const histCallCoi     = bars.map(b => n(b.call?.coi));
  const histPutCoi      = bars.map(b => n(b.put?.coi));
  const histCallVol     = bars.map(b => n(b.call?.volDelta));
  const histPutVol      = bars.map(b => n(b.put?.volDelta));
  const histCallIvRoc   = bars.map(b => n(b.call?.ivRoc));
  const histPutIvRoc    = bars.map(b => n(b.put?.ivRoc));
  const histCallPremRoc = bars.map(b => n(b.call?.premiumRoc));
  const histPutPremRoc  = bars.map(b => n(b.put?.premiumRoc));

  // ── Acceleration (delta of delta) ─────────────────────────────────────────
  const prev = bars[1];
  const callCoiAccel  = prev ? callCoi  - n(prev.call?.coi)      : 0;
  const putCoiAccel   = prev ? putCoi   - n(prev.put?.coi)       : 0;
  const callVolAccel  = prev ? callVol  - n(prev.call?.volDelta) : 0;
  const putVolAccel   = prev ? putVol   - n(prev.put?.volDelta)  : 0;
  const callIvAccel   = prev ? callIvRoc   - n(prev.call?.ivRoc)      : 0;
  const putIvAccel    = prev ? putIvRoc    - n(prev.put?.ivRoc)       : 0;
  const callPremAccel = prev ? callPremRoc - n(prev.call?.premiumRoc) : 0;
  const putPremAccel  = prev ? putPremRoc  - n(prev.put?.premiumRoc)  : 0;

  // ── Rolling z-scores ──────────────────────────────────────────────────────
  // Pass history from bar[1] onward (exclude current bar from its own reference window)
  const histCallCoiExcl  = histCallCoi.slice(1);
  const histPutCoiExcl   = histPutCoi.slice(1);
  const histCallVolExcl  = histCallVol.slice(1);
  const histPutVolExcl   = histPutVol.slice(1);

  const zScoreCallCoi     = zScore(callCoi,     histCallCoiExcl);
  const zScorePutCoi      = zScore(putCoi,      histPutCoiExcl);
  const zScoreCallVol     = zScore(callVol,     histCallVolExcl);
  const zScorePutVol      = zScore(putVol,      histPutVolExcl);
  const zScoreCallIvRoc   = zScore(callIvRoc,   histCallIvRoc.slice(1));
  const zScorePutIvRoc    = zScore(putIvRoc,    histPutIvRoc.slice(1));
  const zScoreCallPremRoc = zScore(callPremRoc, histCallPremRoc.slice(1));
  const zScorePutPremRoc  = zScore(putPremRoc,  histPutPremRoc.slice(1));

  // ── Efficiency & momentum ─────────────────────────────────────────────────
  const callCoiEfficiency = callVol > 0 ? Math.abs(callCoi) / callVol : 0;
  const putCoiEfficiency  = putVol  > 0 ? Math.abs(putCoi)  / putVol  : 0;

  // Premium momentum = sum of last 3 bars' premiumRoc
  const callPremMomentum = sumLast(histCallPremRoc, 3);
  const putPremMomentum  = sumLast(histPutPremRoc, 3);

  // ── Ratios ────────────────────────────────────────────────────────────────
  const callOi = n(bar.call?.oi);
  const putOi  = n(bar.put?.oi);
  const callPutOiRatio  = putOi  > 0 ? callOi  / putOi  : 0;
  const callPutVolRatio = putVol > 0 ? callVol / putVol : 0;

  // ── Session bar index ─────────────────────────────────────────────────────
  // Count bars from today only
  const today = new Date(bar.isoTimestamp ?? new Date()).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const sessionBars = bars.filter(b => {
    if (!b.isoTimestamp) return false;
    return new Date(b.isoTimestamp).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === today;
  });
  const sessionBarIndex = sessionBars.length - 1; // 0-indexed

  return {
    strike,
    timestamp: bar.isoTimestamp ?? new Date().toISOString(),
    spot: spotN,
    distFromSpot: Math.abs(strike - spotN),
    moneyness: moneyness(strike, spotN),

    callCoi, putCoi, callVol, putVol,
    callIv, putIv, callIvRoc, putIvRoc,
    callLtp, putLtp, callPremRoc, putPremRoc,

    callCoiAccel, putCoiAccel,
    callVolAccel, putVolAccel,
    callIvAccel, putIvAccel,
    callPremAccel, putPremAccel,

    zScoreCallCoi, zScorePutCoi,
    zScoreCallVol, zScorePutVol,
    zScoreCallIvRoc, zScorePutIvRoc,
    zScoreCallPremRoc, zScorePutPremRoc,

    callCoiEfficiency, putCoiEfficiency,
    callPremMomentum, putPremMomentum,
    callPutOiRatio, callPutVolRatio,
    sessionBarIndex,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH COMPUTATION (for all active strikes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute features for all strikes in the timeline store within ATM ± range.
 * Returns a Map<strike, BarFeatures>.
 */
export function computeAllFeatures(
  timelineStore: Map<number, any[]>,
  spot: number,
  atmRange = 600
): Map<number, BarFeatures> {
  const results = new Map<number, BarFeatures>();
  const atm = Math.round(spot / 50) * 50;

  timelineStore.forEach((bars, strike) => {
    if (Math.abs(strike - atm) > atmRange) return;
    const features = computeBarFeatures(strike, bars, spot);
    if (features) results.set(strike, features);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION-LEVEL AGGREGATES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute session-level breadth score:
 * fraction of ATM±300 strikes showing meaningful COI activity (|zScore| > 1)
 */
export function computeBreadthScore(features: Map<number, BarFeatures>): number {
  let total = 0, active = 0;
  features.forEach(f => {
    if (f.moneyness === "FAR_OTM") return;
    total++;
    if (Math.abs(f.zScoreCallCoi) > 1 || Math.abs(f.zScorePutCoi) > 1) active++;
  });
  return total > 0 ? active / total : 0;
}

/**
 * Net directional efficiency:
 * Positive = call-side conviction dominant (bullish pressure)
 * Negative = put-side conviction dominant (bearish pressure)
 */
export function computeDirectionalEfficiency(features: Map<number, BarFeatures>): number {
  let callNet = 0, putNet = 0;
  features.forEach(f => {
    // Bullish signals: put writing + call buying/short-cover
    // For efficiency, use signed coi × price direction
    if (f.callCoi > 0 && f.callPremRoc > 0) callNet += f.callCoiEfficiency; // long buildup
    if (f.putCoi  > 0 && f.putPremRoc  < 0) callNet += f.putCoiEfficiency;  // put writing (bullish)
    if (f.callCoi < 0 && f.callPremRoc > 0) callNet += f.callCoiEfficiency; // short cover (bullish)

    if (f.putCoi  > 0 && f.putPremRoc  > 0) putNet += f.putCoiEfficiency;   // put long buildup (bearish)
    if (f.callCoi > 0 && f.callPremRoc < 0) putNet += f.callCoiEfficiency;  // call writing (bearish)
    if (f.putCoi  < 0 && f.putPremRoc  > 0) putNet += f.putCoiEfficiency;   // put short cover (bearish)
  });
  const total = callNet + putNet;
  return total > 0 ? (callNet - putNet) / total : 0;
}

/**
 * Compute IV trend across all nearby strikes:
 * mean ivRoc across ATM ± 200 strikes
 */
export function computeIvTrend(features: Map<number, BarFeatures>): "EXPANDING" | "COMPRESSING" | "STABLE" {
  const near: number[] = [];
  features.forEach(f => {
    if (f.moneyness === "ATM" || f.moneyness === "NEAR") {
      near.push(f.callIvRoc, f.putIvRoc);
    }
  });
  if (near.length === 0) return "STABLE";
  const avg = near.reduce((a, b) => a + b, 0) / near.length;
  if (avg >  0.3) return "EXPANDING";
  if (avg < -0.3) return "COMPRESSING";
  return "STABLE";
}
