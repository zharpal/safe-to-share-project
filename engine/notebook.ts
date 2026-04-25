// ── Flow Intelligence Engine — Rule-Based Commentary Generator ────────────────
// Produces plain-English market commentary from detected events, regime, and walls.
// Every statement is grounded in computed data — no fabrication.

import type {
  FlowEvent, FlowEventType, RegimeSummary, WallState, NotebookEntry, BarFeatures,
} from "./types.js";
import { REGIME_LABELS } from "./regime.js";

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE GENERATORS
// ─────────────────────────────────────────────────────────────────────────────

function regimeParagraph(regime: RegimeSummary): string {
  const label = REGIME_LABELS[regime.regime] ?? regime.regime;
  const biasWord = regime.bias === "BULLISH" ? "bullish" : regime.bias === "BEARISH" ? "bearish" : "neutral";
  let text = `The session is currently classified as **${label}** with ${regime.confidence}% confidence. `;
  text += `Overall bias is ${biasWord} based on directional flow efficiency (${(regime.directionalEfficiency * 100).toFixed(0)}%). `;
  if (regime.ivTrend === "EXPANDING") text += "Implied volatility is expanding — premiums pricing in event risk.";
  else if (regime.ivTrend === "COMPRESSING") text += "IV is compressing — theta sellers have control.";
  else text += "IV is stable — no unusual premium expansion.";
  return text;
}

function wallParagraph(walls: WallState): string {
  if (!walls.callWall || !walls.putWall) return "";

  let text = `Dominant call wall at **${walls.callWall.strike}** (${(walls.callWall.concentration * 100).toFixed(0)}% of call OI) `;
  text += `and put wall at **${walls.putWall.strike}** (${(walls.putWall.concentration * 100).toFixed(0)}% of put OI). `;
  text += `That creates a ${walls.wallWidth}-point range band. `;

  if (walls.recentMigrations.length > 0) {
    const latest = walls.recentMigrations[0];
    text += `The ${latest.fromStrike === walls.callWall.strike ? "call" : "put"} wall recently migrated from ${latest.fromStrike} → ${latest.toStrike} — `;
    text += `a ${latest.direction === "UP" ? "upward" : "downward"} shift that may indicate controlled breakout acceptance.`;
  } else {
    text += `Walls have been stable — consistent with range-bound or max-pain pin behaviour.`;
  }

  if (walls.spotVsWall === "ABOVE_CALL_WALL") {
    text += " Spot has broken above the call wall — bulls in control but watch for reversal.";
  } else if (walls.spotVsWall === "BELOW_PUT_WALL") {
    text += " Spot is below the put wall — bears in control, support has been violated.";
  }

  return text;
}

function eventTypeParagraph(events: FlowEvent[], type: FlowEventType, label: string, insight: string): string | null {
  const matching = events.filter(e => e.type === type);
  if (matching.length === 0) return null;

  const strikes = [...new Set(matching.map(e => e.strike))].sort((a, b) => a - b);
  const highConf = matching.filter(e => e.confidence >= 65);

  let text = `**${label}** has been detected at ${strikes.length} strike${strikes.length > 1 ? "s" : ""}: `;
  text += strikes.slice(0, 5).join(", ");
  if (strikes.length > 5) text += ` and ${strikes.length - 5} more`;
  text += ". ";

  if (highConf.length > 0) {
    const topEvent = highConf.sort((a, b) => b.confidence - a.confidence)[0];
    text += `Strongest signal at ${topEvent.strike} (${topEvent.confidence}% confidence). `;
  }

  text += insight;
  return text;
}

function sweepAbsorptionParagraph(events: FlowEvent[]): string | null {
  const sweeps = events.filter(e => e.type === "LIQUIDITY_SWEEP");
  const absorbs = events.filter(e => e.type === "ABSORPTION");

  if (sweeps.length === 0 && absorbs.length === 0) return null;

  let text = "";
  if (sweeps.length > 0) {
    const strikes = [...new Set(sweeps.map(e => e.strike))].join(", ");
    text += `**Liquidity sweeps** at ${strikes} — sudden burst followed by reversal, suggesting institutional trap or stop-hunt. `;
  }
  if (absorbs.length > 0) {
    const strikes = [...new Set(absorbs.map(e => e.strike))].join(", ");
    text += `**Absorption** at ${strikes}: heavy flow without proportional premium movement — large player quietly absorbing supply. `;
    text += "This often precedes a move once the absorption is complete.";
  }
  return text;
}

function ivParagraph(events: FlowEvent[], ivTrend: string): string | null {
  const shocks = events.filter(e => e.type === "IV_SHOCK");

  if (shocks.length === 0 && ivTrend === "STABLE") return null;

  let text = "";
  if (shocks.length > 0) {
    const strikes = [...new Set(shocks.map(e => e.strike))].join(", ");
    const side = shocks.some(e => e.side === "BOTH") ? "both call and put IV" : shocks[0].side === "CALL" ? "call IV" : "put IV";
    text += `**IV shock** at strikes ${strikes} — ${side} moved abnormally vs recent history. `;
    text += ivTrend === "EXPANDING"
      ? "Broad IV expansion suggests event-driven demand or hedging panic."
      : "Despite the shock, overall IV remains contained — likely isolated activity.";
  } else if (ivTrend === "EXPANDING") {
    text = "Implied volatility is expanding broadly — premium buyers are paying up, possibly ahead of a catalyst.";
  } else if (ivTrend === "COMPRESSING") {
    text = "IV is compressing — writers dominating, time-decay environment, no premium rush.";
  }
  return text;
}

function recentChangeSummary(events: FlowEvent[]): string {
  // Last 3 bars = last 9 minutes of events
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recent = events.filter(e => e.timestamp >= cutoff);

  if (recent.length === 0) return "No significant events in the last 9 minutes.";

  const types = [...new Set(recent.map(e => e.type))];
  const count = recent.length;
  const topType = Object.entries(
    recent.reduce((acc: Record<string, number>, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1])[0];

  return `Last 9 minutes: ${count} events detected. Most active: ${topType[0].replace(/_/g, " ").toLowerCase()} (${topType[1]}×) across ${types.length} event type${types.length > 1 ? "s" : ""}.`;
}

function keyLevelsFromWalls(walls: WallState): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];

  if (walls.putWall) support.push(walls.putWall.strike);
  if (walls.secondaryPutWall) support.push(walls.secondaryPutWall.strike);
  if (walls.callWall) resistance.push(walls.callWall.strike);
  if (walls.secondaryCallWall) resistance.push(walls.secondaryCallWall.strike);

  return { support, resistance };
}

function buildCaveats(regime: RegimeSummary, walls: WallState, events: FlowEvent[]): string[] {
  const caveats: string[] = [];

  if (regime.confidence < 50) {
    caveats.push("Regime confidence is low — signals are mixed, avoid overcommitting.");
  }
  if (walls.recentMigrations.length > 2) {
    caveats.push("Multiple wall migrations detected — range boundaries are shifting, use wide stops.");
  }
  if (events.filter(e => e.type === "CHURN").length > events.length * 0.3) {
    caveats.push("High churn fraction — large volume without conviction, breakouts may fail.");
  }
  if (walls.spotVsWall === "ABOVE_CALL_WALL") {
    caveats.push("Spot is above the call wall — if writing resumes there, upside may stall.");
  }
  if (walls.spotVsWall === "BELOW_PUT_WALL") {
    caveats.push("Spot below put wall — if put writing resumes, expect range to shift lower.");
  }
  if (events.filter(e => e.type === "ABSORPTION").length > 2) {
    caveats.push("Absorption events active — direction unclear until absorption completes.");
  }

  return caveats;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

export function generateNotebook(
  regime: RegimeSummary,
  walls: WallState,
  events: FlowEvent[],
  spot: number,
  date: string
): NotebookEntry {
  const paragraphs: string[] = [];

  // 1. Regime paragraph
  paragraphs.push(regimeParagraph(regime));

  // 2. Wall paragraph
  const wallPara = wallParagraph(walls);
  if (wallPara) paragraphs.push(wallPara);

  // 3. Key event type paragraphs
  const writingPara = eventTypeParagraph(
    events, "FRESH_WRITING", "Fresh option writing",
    "Writers are establishing positions — this creates ceiling/floor zones that spot tends to respect short-term."
  );
  if (writingPara) paragraphs.push(writingPara);

  const buildupPara = eventTypeParagraph(
    events, "LONG_BUILDUP", "Long buildup",
    "Fresh longs entering the market — momentum buyers or hedgers positioning for a move."
  );
  if (buildupPara) paragraphs.push(buildupPara);

  const coverPara = eventTypeParagraph(
    events, "SHORT_COVERING", "Short covering",
    "Defensive unwinding — shorts exiting creates immediate price support or resistance removal."
  );
  if (coverPara) paragraphs.push(coverPara);

  const unwindPara = eventTypeParagraph(
    events, "LONG_UNWINDING", "Long unwinding",
    "Longs exiting removes support — watch for acceleration if put writing doesn't step in."
  );
  if (unwindPara) paragraphs.push(unwindPara);

  // 4. Sweep + absorption
  const trapPara = sweepAbsorptionParagraph(events);
  if (trapPara) paragraphs.push(trapPara);

  // 5. IV
  const ivPara = ivParagraph(events, regime.ivTrend);
  if (ivPara) paragraphs.push(ivPara);

  // ── Final assembly ────────────────────────────────────────────────────────
  const { support, resistance } = keyLevelsFromWalls(walls);
  const caveats = buildCaveats(regime, walls, events);

  // Headline
  const regimeLabel = REGIME_LABELS[regime.regime] ?? regime.regime;
  const biasWord = regime.bias === "BULLISH" ? "Bullish" : regime.bias === "BEARISH" ? "Bearish" : "Neutral";
  const headline = `${regimeLabel} session — ${biasWord} bias (${regime.confidence}% confidence). ${
    walls.callWall && walls.putWall
      ? `Key band: ${walls.putWall.strike}–${walls.callWall.strike}.`
      : ""
  }`;

  // Notebook bias
  const bias = regime.directionalEfficiency > 0.2 ? "BULLISH"
    : regime.directionalEfficiency < -0.2 ? "BEARISH"
    : regime.bias === "BULLISH" ? "BULLISH"
    : regime.bias === "BEARISH" ? "BEARISH"
    : events.filter(e => ["FRESH_WRITING", "CHURN"].includes(e.type)).length > events.length * 0.4
      ? "NEUTRAL"
      : "NEUTRAL";

  return {
    date,
    generatedAt: new Date().toISOString(),
    regime: regime.regime,
    bias: bias as NotebookEntry["bias"],
    confidence: regime.confidence,
    headline,
    paragraphs: paragraphs.filter(Boolean),
    recentChangeSummary: recentChangeSummary(events),
    caveats,
    keyLevels: { support, resistance },
  };
}
