import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Zap, BookOpen, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Waves, AlertTriangle, Shield, Activity } from "lucide-react";
import { EventTape } from "./flow/EventTape";
import { RegimeBox } from "./flow/RegimeBox";
import { WallsPanel } from "./flow/WallsPanel";
import { AINotebook } from "./flow/AINotebook";
import { AnomalyHeatmap } from "./flow/AnomalyHeatmap";
import { SimilarDays } from "./flow/SimilarDays";
import { PreMovePanel } from "./flow/PreMovePanel";

// ── Shared type shims (mirrors engine/types.ts) ───────────────────────────────
// These are used only for typing the API responses in the frontend.
// The full interfaces live in engine/types.ts (server-side).

type FlowEventType =
  | "FRESH_WRITING" | "SHORT_COVERING" | "LONG_BUILDUP" | "LONG_UNWINDING"
  | "CHURN" | "WALL_CREATION" | "WALL_MIGRATION" | "LIQUIDITY_SWEEP"
  | "ABSORPTION" | "IV_SHOCK" | "EXPIRY_PIN";

interface FlowEvent {
  id: string; date: string; timestamp: string; strike: number;
  type: FlowEventType; side: "CALL" | "PUT" | "BOTH";
  confidence: number; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  explanation: string; features: Record<string, any>;
}

interface RegimeSummary {
  date: string; computedAt: string;
  regime: string; confidence: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  reasons: string[]; eventCounts: Record<string, number>;
  breadthScore: number; directionalEfficiency: number;
  ivTrend: "EXPANDING" | "COMPRESSING" | "STABLE";
  priorRegime?: string; priorRegimeAt?: string;
}

interface WallState {
  computedAt: string;
  callWall: any; putWall: any;
  secondaryCallWall: any; secondaryPutWall: any;
  recentMigrations: any[];
  wallBand: any; wallWidth: number;
  spotVsWall: string;
}

interface NotebookEntry {
  date: string; generatedAt: string;
  regime: string; bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "SPLIT";
  confidence: number; headline: string;
  paragraphs: string[]; recentChangeSummary: string;
  caveats: string[]; keyLevels: { support: number[]; resistance: number[] };
}

interface AnomalyEntry {
  strike: number; anomalyScore: number;
  dominantType: FlowEventType; confidence: number;
  explanation: string; callZScore: number; putZScore: number;
}

interface PatternMatch {
  pattern: any; similarity: number; reasons: string[]; caveats: string[];
}

interface MoveInstance {
  id: string; date: string; direction: "UP" | "DOWN"; magnitude: number;
  startTs: string; triggerTs: string; peakTs: string;
  spotAtStart: number; spotAtPeak: number;
  preMoveWindows: any[]; preMoveEventSequence: string[];
  wallBehaviorNote: string; ivBehaviorNote: string;
  outcome: "SUSTAINED" | "FAILED" | "PARTIAL" | "PENDING"; confidence: number;
}

interface SimilarDay {
  date: string; similarity: number; matchingFeatures: string[];
  regime: string; outcome: any; note: string;
}

// ── Anomaly type plain-English guide ─────────────────────────────────────────
const ANOMALY_GUIDE = [
  {
    type: "Sweep",
    color: "bg-red-100 text-red-700 border-red-200",
    icon: Waves,
    what: "A sudden, large OI burst followed by a quick reversal.",
    means: "Likely a market-maker trap or institutional stop-hunt. Large money moved in and out rapidly — often before a real directional move.",
    action: "Don't chase the spike. Wait for price to settle. The real direction often becomes clear 5–10 mins after the sweep.",
  },
  {
    type: "Writing",
    color: "bg-orange-100 text-orange-700 border-orange-200",
    icon: TrendingDown,
    what: "OI rose significantly while premium fell or stayed flat.",
    means: "Someone SOLD options here — they collected premium and are betting the market won't cross this level. Usually FIIs or PropDesk selling ATM/slight OTM options.",
    action: "This strike is a key ceiling (if CE Writing) or floor (if PE Writing). Treat it as resistance/support for the session.",
  },
  {
    type: "S.Cover",
    color: "bg-amber-100 text-amber-700 border-amber-200",
    icon: TrendingUp,
    what: "OI dropped significantly while premium rose.",
    means: "Shorts (option sellers) are EXITING their positions — they're buying back options they sold, causing OI to fall and premium to rise. This is bullish for calls, bearish for puts.",
    action: "Short covering often precedes a move through the strike. Watch for breakout if this happens at a wall level.",
  },
  {
    type: "Long Build",
    color: "bg-blue-100 text-blue-700 border-blue-200",
    icon: TrendingUp,
    what: "OI rose and premium also rose.",
    means: "Fresh directional BUYING — someone paid premium to buy options, betting on a move. More aggressive than writing. Usually signals strong conviction.",
    action: "If CE Long Buildup: bullish signal. If PE Long Buildup: bearish. Watch for follow-through.",
  },
  {
    type: "Churn",
    color: "bg-gray-100 text-gray-600 border-gray-200",
    icon: Activity,
    what: "High OI volume but no clear directional pattern.",
    means: "Market participants are rolling positions or trading both sides without conviction. Usually means indecision or a range-bound session.",
    action: "Avoid directional bets during churn. Wait for a cleaner signal at a wall level.",
  },
  {
    type: "IV Shock",
    color: "bg-purple-100 text-purple-700 border-purple-200",
    icon: AlertTriangle,
    what: "Implied Volatility spiked or collapsed abnormally at this strike.",
    means: "Either panic buying (IV spike = fear) or unusual selling pressure (IV collapse = complacency). Large IV moves often precede significant price moves.",
    action: "IV expansion = expect volatility. IV compression = market expects calm but can be wrong. Watch the strike closely.",
  },
  {
    type: "Wall",
    color: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: Shield,
    what: "This strike has the highest OI concentration — a dominant ceiling or floor.",
    means: "Max Pain / Wall strikes are the levels where option sellers have the most to gain by keeping price near. Market tends to gravitate toward these levels near expiry.",
    action: "Treat as strong support (Put Wall) or resistance (Call Wall). Breaks of wall levels are high-conviction directional signals.",
  },
];

// ── Main component ────────────────────────────────────────────────────────────

export function FlowIntelligence() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [regime,          setRegime]          = useState<RegimeSummary | null>(null);
  const [regimeHistory,   setRegimeHistory]   = useState<RegimeSummary[]>([]);
  const [walls,           setWalls]           = useState<WallState | null>(null);
  const [notebook,        setNotebook]        = useState<NotebookEntry | null>(null);
  const [events,          setEvents]          = useState<FlowEvent[]>([]);
  const [anomalies,       setAnomalies]       = useState<AnomalyEntry[]>([]);
  const [moves,           setMoves]           = useState<MoveInstance[]>([]);
  const [patternMatches,  setPatternMatches]  = useState<PatternMatch[]>([]);
  const [similarDays,     setSimilarDays]     = useState<SimilarDay[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [refreshing,      setRefreshing]      = useState(false);
  const [lastUpdated,     setLastUpdated]     = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [stateRes, movesRes, similarRes, patternRes] = await Promise.all([
        fetch("/api/flow/state"),
        fetch("/api/flow/moves"),
        fetch("/api/flow/similar-days"),
        fetch("/api/flow/pattern-match"),
      ]);

      if (stateRes.ok) {
        const state = await stateRes.json();
        if (state.regime)   setRegime(state.regime);
        if (state.walls)    setWalls(state.walls);
        if (state.notebook) setNotebook(state.notebook);
        if (state.recentEvents)  setEvents(state.recentEvents);
        if (state.topAnomalies)  setAnomalies(state.topAnomalies);
      }

      // Regime history
      const regimeRes = await fetch("/api/flow/regime");
      if (regimeRes.ok) {
        const r = await regimeRes.json();
        if (r.history) setRegimeHistory(r.history);
      }

      if (movesRes.ok) {
        const m = await movesRes.json();
        if (m.moves) setMoves(m.moves);
      }

      if (similarRes.ok) {
        const s = await similarRes.json();
        if (s.similar) setSimilarDays(s.similar);
      }

      if (patternRes.ok) {
        const p = await patternRes.json();
        if (p.matches) setPatternMatches(p.matches);
      }

      setLastUpdated(new Date());
    } catch (e) {
      console.error("[FlowIntelligence] fetch error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load + auto-refresh every 90s
  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 90_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const handleRefresh = async () => {
    setRefreshing(true);
    // Trigger engine re-run on server
    try { await fetch("/api/flow/analyze", { method: "POST" }); } catch {}
    setTimeout(fetchAll, 3000); // wait 3s for engine to finish
  };

  return (
    <div className="p-4 md:p-6 space-y-4 tab-panel-enter">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-dark flex items-center gap-2">
            <Zap size={20} className="text-amber-500" />
            Flow Intelligence
          </h2>
          <p className="text-xs text-dark/50 mt-0.5">
            Real-time option flow · regime detection · walls · anomalies · pattern memory
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[10px] text-dark/40">
              Updated {lastUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </span>
          )}
          <button
            onClick={() => setGuideOpen(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 rounded-lg text-xs font-medium transition-colors"
          >
            <BookOpen size={12} />
            {guideOpen ? "Hide Guide" : "How to read this tab"}
            {guideOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue/10 hover:bg-blue/20 text-blue border border-blue/20 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Running…" : "Run Now"}
          </button>
        </div>
      </div>

      {/* ── Plain-English Guide (collapsible) ───────────────────────────────── */}
      {guideOpen && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 space-y-4 card-animate">
          <p className="text-sm font-bold text-amber-800">How to read Flow Intelligence</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-amber-200/60 bg-white/70 px-4 py-3 space-y-1">
              <p className="text-xs font-bold text-dark uppercase tracking-wide">Market Regime</p>
              <p className="text-xs text-dark/70">
                The engine classifies the session as <strong>Trend Up</strong>, <strong>Trend Down</strong>,
                <strong> Range</strong>, or <strong>Choppy</strong> by looking at all option flow events together.
                Confidence tells you how clear the signal is — below 50% = mixed signals, stay cautious.
              </p>
            </div>

            <div className="rounded-xl border border-amber-200/60 bg-white/70 px-4 py-3 space-y-1">
              <p className="text-xs font-bold text-dark uppercase tracking-wide">Dominant Walls (Support &amp; Resistance)</p>
              <p className="text-xs text-dark/70">
                The strike with the <strong>most OI concentration</strong> on the call side = the Call Wall (resistance ceiling).
                The put side = the Put Wall (support floor). Price tends to stay within these two walls.
                When a wall "migrates" (moves up/down), the market is repositioning — watch for a new direction.
              </p>
            </div>

            <div className="rounded-xl border border-amber-200/60 bg-white/70 px-4 py-3 space-y-1">
              <p className="text-xs font-bold text-dark uppercase tracking-wide">Anomaly Leaderboard — What are "Anomaly Strikes"?</p>
              <p className="text-xs text-dark/70">
                Each strike gets a <strong>z-score</strong> — how far its OI activity is from its own historical average.
                A z-score of +3σ means something very unusual happened here (large institutional order).
                The leaderboard ranks the <strong>top 10 most unusual strikes</strong> this session.
                The color shows severity: red = extreme, orange = high, yellow = moderate.
              </p>
            </div>

            <div className="rounded-xl border border-amber-200/60 bg-white/70 px-4 py-3 space-y-1">
              <p className="text-xs font-bold text-dark uppercase tracking-wide">AI Notebook</p>
              <p className="text-xs text-dark/70">
                A rule-based summary of what all the above signals mean together.
                Updated every 5 minutes. Think of it as a running commentary on the session.
                The <strong>Watch Out</strong> section flags risks or mixed signals.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold text-amber-800 uppercase tracking-wide">Anomaly Types — What Each One Means</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {ANOMALY_GUIDE.map(({ type, color, icon: Icon, what, means, action }) => (
                <div key={type} className={`rounded-xl border px-3 py-2.5 ${color} space-y-1`}>
                  <div className="flex items-center gap-1.5 font-bold text-xs">
                    <Icon size={12} />
                    {type}
                  </div>
                  <p className="text-[11px] opacity-80"><strong>What:</strong> {what}</p>
                  <p className="text-[11px] opacity-80"><strong>Means:</strong> {means}</p>
                  <p className="text-[11px] opacity-90 font-medium"><strong>Action:</strong> {action}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-amber-300 bg-amber-100 px-4 py-3">
            <p className="text-xs font-bold text-amber-800 mb-1">Quick Decision Framework</p>
            <ul className="text-xs text-amber-800/80 space-y-0.5 list-disc list-inside">
              <li>Regime = Trend Up + Writing at Put Wall → buy dips near the Put Wall level</li>
              <li>Regime = Trend Down + Writing at Call Wall → sell rallies near the Call Wall</li>
              <li>Sweep anomaly near a wall → potential trap. Don't trade the first 5-min candle after it</li>
              <li>Short Covering at a resistance → resistance weakening, possible breakout</li>
              <li>Churn + low confidence → sit out, wait for clarity</li>
            </ul>
          </div>
        </div>
      )}

      {/* Row 1: Regime (full width) */}
      <RegimeBox regime={regime} history={regimeHistory} loading={loading} />

      {/* Row 2: 3-column grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <WallsPanel walls={walls} loading={loading} />
        <AnomalyHeatmap anomalies={anomalies} loading={loading} />
        <AINotebook notebook={notebook} loading={loading} />
      </div>

      {/* Row 3: Event Tape (full width) */}
      <div>
        <EventTape events={events} loading={loading} />
      </div>

      {/* Row 4: Similar days + Pre-move forensics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SimilarDays similar={similarDays} loading={loading} />
        <PreMovePanel moves={moves} patternMatches={patternMatches} loading={loading} />
      </div>
    </div>
  );
}
