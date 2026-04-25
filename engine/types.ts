// ── Flow Intelligence Engine — Shared Types ──────────────────────────────────
// All interfaces used across the analytics engine and API layer.

// ─────────────────────────────────────────────────────────────────────────────
// RAW BAR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a bar field that may be a number or a numeric string. */
export function n(v: any): number {
  if (v == null) return 0;
  const f = typeof v === "number" ? v : parseFloat(v);
  return isFinite(f) ? f : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-BAR FEATURES
// ─────────────────────────────────────────────────────────────────────────────

export type Moneyness = "ATM" | "NEAR" | "OTM" | "FAR_OTM";

export interface BarFeatures {
  strike: number;
  timestamp: string;      // isoTimestamp of the bar
  spot: number;

  // Distance / moneyness
  distFromSpot: number;   // |strike - spot|
  moneyness: Moneyness;

  // Numeric values (parsed from string fields)
  callCoi: number;
  putCoi: number;
  callVol: number;
  putVol: number;
  callIv: number;
  putIv: number;
  callIvRoc: number;
  putIvRoc: number;
  callLtp: number;
  putLtp: number;
  callPremRoc: number;
  putPremRoc: number;

  // Rate-of-change / acceleration
  callCoiAccel: number;   // coi[t] - coi[t-1]
  putCoiAccel: number;
  callVolAccel: number;
  putVolAccel: number;
  callIvAccel: number;
  putIvAccel: number;
  callPremAccel: number;
  putPremAccel: number;

  // Rolling z-scores (window = last 20 bars)
  zScoreCallCoi: number;
  zScorePutCoi: number;
  zScoreCallVol: number;
  zScorePutVol: number;
  zScoreCallIvRoc: number;
  zScorePutIvRoc: number;
  zScoreCallPremRoc: number;
  zScorePutPremRoc: number;

  // Efficiency / concentration
  callCoiEfficiency: number;  // |coi| / (vol + 1) — how directional is flow
  putCoiEfficiency: number;
  callPremMomentum: number;   // sum of last 3 premiumRoc
  putPremMomentum: number;

  // Ratios
  callPutOiRatio: number;
  callPutVolRatio: number;

  // Session index (which bar number of the day: 0 = first bar)
  sessionBarIndex: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW EVENTS
// ─────────────────────────────────────────────────────────────────────────────

export type FlowEventType =
  | "FRESH_WRITING"
  | "SHORT_COVERING"
  | "LONG_BUILDUP"
  | "LONG_UNWINDING"
  | "CHURN"
  | "WALL_CREATION"
  | "WALL_MIGRATION"
  | "LIQUIDITY_SWEEP"
  | "ABSORPTION"
  | "IV_SHOCK"
  | "EXPIRY_PIN";

export type EventSide = "CALL" | "PUT" | "BOTH";
export type EventSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface FlowEvent {
  id: string;               // {date}_{strike}_{type}_{ts}
  date: string;             // YYYY-MM-DD
  timestamp: string;        // ISO timestamp of the bar
  strike: number;
  type: FlowEventType;
  side: EventSide;
  confidence: number;       // 0–100
  severity: EventSeverity;
  explanation: string;      // plain-English, 1–2 sentences
  // Key driving features (for UI detail popover)
  features: {
    coiChange?: number;
    volDelta?: number;
    premiumChange?: number;
    ivChange?: number;
    zScore?: number;
    efficiency?: number;
    [key: string]: any;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIME
// ─────────────────────────────────────────────────────────────────────────────

export type RegimeLabel =
  | "TREND_UP"
  | "TREND_DOWN"
  | "RANGE_DAY"
  | "EXPIRY_PIN"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "TRAP_HEAVY"
  | "HIGH_VOL_EVENT"
  | "LOW_CONVICTION_CHURN"
  | "UNKNOWN";

export interface RegimeSummary {
  date: string;
  computedAt: string;       // ISO timestamp
  regime: RegimeLabel;
  confidence: number;       // 0–100
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  reasons: string[];        // ordered list of supporting reasons
  eventCounts: Record<FlowEventType, number>;
  breadthScore: number;     // fraction of strikes showing conviction (0–1)
  directionalEfficiency: number;  // net direction / total activity
  ivTrend: "EXPANDING" | "COMPRESSING" | "STABLE";
  priorRegime?: RegimeLabel;
  priorRegimeAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLS
// ─────────────────────────────────────────────────────────────────────────────

export interface WallStrike {
  strike: number;
  oi: number;               // total OI at this strike
  concentration: number;    // fraction of total OI across all strikes
  stabilityBars: number;    // consecutive bars as dominant wall
  replenished: boolean;     // OI was added in last bar (not just static)
  isRespected: boolean;     // price has not cleanly broken through
}

export interface WallMigration {
  timestamp: string;
  fromStrike: number;
  toStrike: number;
  direction: "UP" | "DOWN";
  oiShift: number;
}

export interface WallState {
  computedAt: string;
  callWall: WallStrike | null;
  putWall: WallStrike | null;
  secondaryCallWall: WallStrike | null;
  secondaryPutWall: WallStrike | null;
  recentMigrations: WallMigration[];
  wallBand: { callStrike: number; putStrike: number } | null;  // current trading range
  wallWidth: number;        // callWall - putWall (point spread)
  spotVsWall: "ABOVE_CALL_WALL" | "BELOW_PUT_WALL" | "INSIDE_BAND" | "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTEBOOK (commentary)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotebookEntry {
  date: string;
  generatedAt: string;
  regime: RegimeLabel;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "SPLIT";
  confidence: number;       // 0–100
  headline: string;         // single sentence summary
  paragraphs: string[];     // ordered analysis paragraphs
  recentChangeSummary: string;   // what changed in last 3 intervals
  caveats: string[];        // conditions that would invalidate the thesis
  keyLevels: { support: number[]; resistance: number[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVE INSTANCES
// ─────────────────────────────────────────────────────────────────────────────

export type MoveDirection = "UP" | "DOWN";
export type MoveOutcome = "SUSTAINED" | "FAILED" | "PARTIAL" | "PENDING";

export interface PreMoveWindow {
  windowLabel: string;      // "T-30", "T-15", "T-6", "T-3"
  timestamp: string;
  spotAtWindow: number;
  callOiChange: number;     // net COI across ATM ±200 strikes
  putOiChange: number;
  callVolume: number;
  putVolume: number;
  ivLevel: number;          // average IV at ATM ±100
  coiEfficiency: number;    // average directional efficiency
  breadth: number;          // fraction of strikes with meaningful activity
  dominantEvent: FlowEventType | null;
  anomalyScore: number;     // 0–100
}

export interface MoveInstance {
  id: string;
  date: string;
  direction: MoveDirection;
  magnitude: number;        // Nifty points
  startTs: string;          // structural start (our inferred start)
  triggerTs: string;        // confirmed expansion begin
  peakTs: string;           // highest/lowest point
  spotAtStart: number;
  spotAtPeak: number;
  preMoveWindows: PreMoveWindow[];
  preMoveEventSequence: FlowEventType[];
  wallBehaviorNote: string;
  ivBehaviorNote: string;
  outcome: MoveOutcome;
  confidence: number;       // confidence in move-start inference
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN MEMORY
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureVector {
  // Normalised [0,1] features for cosine similarity
  callPutOiImbalance: number;
  ivLevel: number;
  ivTrend: number;           // -1 compressing, 0 stable, +1 expanding
  breadthScore: number;
  coiEfficiency: number;
  wallMigrationRecent: number;  // 0/1
  churnRatio: number;
  writingRatio: number;
  buildupRatio: number;
  sweepRecent: number;       // 0/1
  distFromMaxPain: number;   // normalised spot distance from max pain
}

export interface PrecursorPattern {
  id: string;
  moveDate: string;
  moveDirection: MoveDirection;
  moveMagnitude: number;
  moveStartTs: string;
  featureVector: FeatureVector;
  preMoveEventSequence: FlowEventType[];
  dominantStrikes: number[];
  wallBehavior: string;
  ivBehavior: string;
  outcome: MoveOutcome;
  successCount: number;
  failureCount: number;
  reliabilityScore: number;  // 0–1
  lastSeen: string;
  avgMagnitude: number;
  occurrenceCount: number;
}

export interface PatternMatch {
  pattern: PrecursorPattern;
  similarity: number;        // 0–1 cosine similarity
  reasons: string[];
  caveats: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION SIGNATURES (for similar-day retrieval)
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionSignature {
  date: string;
  features: {
    oiConcentrationHHI: number;
    callPutOiImbalance: number;
    ivExpansionRate: number;
    freshWritingFrac: number;
    longBuildupFrac: number;
    churnFrac: number;
    sweepFrac: number;
    wallMigrationCount: number;
    breadthScore: number;
    directionalEfficiency: number;
    sessionVolatility: number;
    expiryProximityDays: number;
  };
  outcome: {
    direction: MoveDirection | "FLAT";
    magnitude: number;
    regime: RegimeLabel;
  };
}

export interface SimilarDay {
  date: string;
  similarity: number;        // 0–1
  matchingFeatures: string[];
  regime: RegimeLabel;
  outcome: SessionSignature["outcome"];
  note: string;              // "What happened next" summary
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED FLOW STATE (API response shape)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowState {
  computedAt: string;
  regime: RegimeSummary | null;
  walls: WallState | null;
  notebook: NotebookEntry | null;
  recentEvents: FlowEvent[];     // last 30 events across all strikes
  topAnomalies: AnomalyEntry[];  // top 10 anomaly strikes
  livePatternMatch: PatternMatch | null;
}

export interface AnomalyEntry {
  strike: number;
  anomalyScore: number;          // 0–100 composite
  dominantType: FlowEventType;
  confidence: number;
  explanation: string;
  callZScore: number;
  putZScore: number;
}
