// ── Flow Intelligence Engine — Dominant Wall Tracker ─────────────────────────
// Detects the strongest call and put OI concentration zones and tracks migration.

import type { WallState, WallStrike, WallMigration } from "./types.js";
import { n } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

interface StrikeOi {
  strike: number;
  callOi: number;
  putOi: number;
  callCoi: number;  // last bar's COI
  putCoi: number;
  stabilityBars: number;  // passed in from prior wall state
}

function getStrikeOis(timelineStore: Map<number, any[]>, spot: number, atmRange = 700): StrikeOi[] {
  const result: StrikeOi[] = [];
  const atm = Math.round(spot / 50) * 50;

  timelineStore.forEach((bars, strike) => {
    if (Math.abs(strike - atm) > atmRange) return;
    if (bars.length === 0) return;

    const bar = bars[0]; // most recent
    result.push({
      strike,
      callOi: n(bar.call?.oi),
      putOi:  n(bar.put?.oi),
      callCoi: n(bar.call?.coi),
      putCoi:  n(bar.put?.coi),
      stabilityBars: 0, // will be updated from prior state
    });
  });

  return result;
}

function computeConcentration(oi: number, totalOi: number): number {
  return totalOi > 0 ? oi / totalOi : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN WALL DETECTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect dominant call and put walls from the current timelineStore snapshot.
 *
 * @param timelineStore - Map<strike, bars[]> (newest-first bars)
 * @param spot - Current Nifty spot
 * @param priorState - Previous WallState (for stability tracking + migration)
 */
export function detectWalls(
  timelineStore: Map<number, any[]>,
  spot: number,
  priorState?: WallState
): WallState {
  const computedAt = new Date().toISOString();
  const strikes = getStrikeOis(timelineStore, spot);

  if (strikes.length === 0) {
    return {
      computedAt,
      callWall: null, putWall: null,
      secondaryCallWall: null, secondaryPutWall: null,
      recentMigrations: priorState?.recentMigrations ?? [],
      wallBand: null,
      wallWidth: 0,
      spotVsWall: "UNKNOWN",
    };
  }

  // Total OI for concentration
  const totalCallOi = strikes.reduce((s, x) => s + x.callOi, 0);
  const totalPutOi  = strikes.reduce((s, x) => s + x.putOi, 0);

  // Sort descending by OI
  const callRanked = [...strikes].sort((a, b) => b.callOi - a.callOi);
  const putRanked  = [...strikes].sort((a, b) => b.putOi  - a.putOi);

  // ── Stability tracking ────────────────────────────────────────────────────
  const prevCallWall = priorState?.callWall;
  const prevPutWall  = priorState?.putWall;

  function getStability(strike: number, prevWall: WallStrike | null): number {
    if (!prevWall) return 1;
    return prevWall.strike === strike ? prevWall.stabilityBars + 1 : 1;
  }

  const topCall = callRanked[0];
  const topPut  = putRanked[0];

  const callWall: WallStrike = {
    strike: topCall.strike,
    oi: topCall.callOi,
    concentration: computeConcentration(topCall.callOi, totalCallOi),
    stabilityBars: getStability(topCall.strike, prevCallWall ?? null),
    replenished: topCall.callCoi > 100,
    isRespected: topCall.strike >= spot - 50,  // spot hasn't blown through call wall
  };

  const topPut2 = putRanked[0];
  const putWall: WallStrike = {
    strike: topPut2.strike,
    oi: topPut2.putOi,
    concentration: computeConcentration(topPut2.putOi, totalPutOi),
    stabilityBars: getStability(topPut2.strike, prevPutWall ?? null),
    replenished: topPut2.putCoi > 100,
    isRespected: topPut2.strike <= spot + 50,  // spot hasn't broken below put wall
  };

  // Secondary walls
  const secondaryCallWall: WallStrike | null = callRanked[1] ? {
    strike: callRanked[1].strike,
    oi: callRanked[1].callOi,
    concentration: computeConcentration(callRanked[1].callOi, totalCallOi),
    stabilityBars: 1,
    replenished: callRanked[1].callCoi > 50,
    isRespected: callRanked[1].strike >= spot,
  } : null;

  const secondaryPutWall: WallStrike | null = putRanked[1] ? {
    strike: putRanked[1].strike,
    oi: putRanked[1].putOi,
    concentration: computeConcentration(putRanked[1].putOi, totalPutOi),
    stabilityBars: 1,
    replenished: putRanked[1].putCoi > 50,
    isRespected: putRanked[1].strike <= spot,
  } : null;

  // ── Migration detection ───────────────────────────────────────────────────
  const migrations: WallMigration[] = [...(priorState?.recentMigrations ?? [])];

  if (prevCallWall && prevCallWall.strike !== callWall.strike) {
    const migration: WallMigration = {
      timestamp: computedAt,
      fromStrike: prevCallWall.strike,
      toStrike: callWall.strike,
      direction: callWall.strike > prevCallWall.strike ? "UP" : "DOWN",
      oiShift: callWall.oi - prevCallWall.oi,
    };
    migrations.unshift(migration);
  }

  if (prevPutWall && prevPutWall.strike !== putWall.strike) {
    const migration: WallMigration = {
      timestamp: computedAt,
      fromStrike: prevPutWall.strike,
      toStrike: putWall.strike,
      direction: putWall.strike > prevPutWall.strike ? "UP" : "DOWN",
      oiShift: putWall.oi - prevPutWall.oi,
    };
    migrations.unshift(migration);
  }

  // Keep only last 10 migrations
  const recentMigrations = migrations.slice(0, 10);

  // ── Wall band and spot position ───────────────────────────────────────────
  const wallBand = {
    callStrike: callWall.strike,
    putStrike: putWall.strike,
  };
  const wallWidth = Math.abs(callWall.strike - putWall.strike);

  let spotVsWall: WallState["spotVsWall"] = "INSIDE_BAND";
  if (spot > callWall.strike + 50) spotVsWall = "ABOVE_CALL_WALL";
  else if (spot < putWall.strike - 50) spotVsWall = "BELOW_PUT_WALL";

  return {
    computedAt,
    callWall,
    putWall,
    secondaryCallWall,
    secondaryPutWall,
    recentMigrations,
    wallBand,
    wallWidth,
    spotVsWall,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WALL MIGRATION EVENT DETECTOR
// Converts a WallMigration into a FlowEvent-compatible structure for event tape
// ─────────────────────────────────────────────────────────────────────────────

import type { FlowEvent } from "./types.js";

export function wallMigrationToEvent(migration: WallMigration, date: string): FlowEvent {
  return {
    id: `wall_migration_${migration.timestamp.slice(0, 16).replace(/[-:T]/g, "")}`,
    date,
    timestamp: migration.timestamp,
    strike: migration.toStrike,
    type: "WALL_MIGRATION",
    side: "BOTH",
    confidence: 70,
    severity: "HIGH",
    explanation: `Wall migrated ${migration.direction === "UP" ? "upward" : "downward"} from ${migration.fromStrike} → ${migration.toStrike}. OI shift: ${migration.oiShift > 0 ? "+" : ""}${migration.oiShift.toFixed(0)} contracts. Suggests institutional repositioning.`,
    features: { fromStrike: migration.fromStrike, toStrike: migration.toStrike, oiShift: migration.oiShift },
  };
}
