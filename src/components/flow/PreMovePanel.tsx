import { useState } from "react";
import { Crosshair, TrendingUp, TrendingDown, Clock, ChevronDown, ChevronUp, Star } from "lucide-react";

type MoveDirection = "UP" | "DOWN";
type MoveOutcome = "SUSTAINED" | "FAILED" | "PARTIAL" | "PENDING";
type FlowEventType = string;

interface PreMoveWindow {
  windowLabel: string;
  timestamp: string;
  spotAtWindow: number;
  callOiChange: number;
  putOiChange: number;
  callVolume: number;
  putVolume: number;
  ivLevel: number;
  coiEfficiency: number;
  breadth: number;
  dominantEvent: FlowEventType | null;
  anomalyScore: number;
}

interface MoveInstance {
  id: string;
  date: string;
  direction: MoveDirection;
  magnitude: number;
  startTs: string;
  triggerTs: string;
  peakTs: string;
  spotAtStart: number;
  spotAtPeak: number;
  preMoveWindows: PreMoveWindow[];
  preMoveEventSequence: FlowEventType[];
  wallBehaviorNote: string;
  ivBehaviorNote: string;
  outcome: MoveOutcome;
  confidence: number;
}

interface PatternMatch {
  pattern: {
    id: string;
    moveDate: string;
    moveDirection: MoveDirection;
    moveMagnitude: number;
    reliabilityScore: number;
    occurrenceCount: number;
    successCount: number;
    failureCount: number;
  };
  similarity: number;
  reasons: string[];
  caveats: string[];
}

interface PreMovePanelProps {
  moves: MoveInstance[];
  patternMatches: PatternMatch[];
  loading: boolean;
}

const OUTCOME_META: Record<MoveOutcome, { label: string; cls: string }> = {
  SUSTAINED: { label: "Sustained",  cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  FAILED:    { label: "Failed",     cls: "bg-rose-100 text-rose-700 border-rose-200" },
  PARTIAL:   { label: "Partial",    cls: "bg-amber-100 text-amber-700 border-amber-200" },
  PENDING:   { label: "Pending",    cls: "bg-blue-100 text-blue-700 border-blue-200" },
};

function TimeIst(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  } catch { return "--:--"; }
}

function MoveCard({ move }: { move: MoveInstance }) {
  const [expanded, setExpanded] = useState(false);
  const isUp = move.direction === "UP";
  const outMeta = OUTCOME_META[move.outcome];

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-white transition-colors"
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isUp ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
          {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-slate-800">
              {isUp ? "+" : "-"}{move.magnitude} pts
            </span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${outMeta.cls}`}>{outMeta.label}</span>
            <span className="text-[10px] text-slate-400 tabular-nums">{move.date}</span>
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Start: {TimeIst(move.startTs)} · Trigger: {TimeIst(move.triggerTs)} · Peak: {TimeIst(move.peakTs)}
          </p>
        </div>
        <div className="shrink-0 text-slate-400">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-slate-200 pt-3">
          {/* Pre-move windows */}
          {move.preMoveWindows.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Pre-Move Windows</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {move.preMoveWindows.map(w => (
                  <div key={w.windowLabel} className="shrink-0 p-2 rounded-lg bg-white border border-slate-200 w-28 text-center">
                    <p className="text-[10px] font-bold text-slate-500 mb-1">{w.windowLabel}</p>
                    <p className="text-xs font-bold text-slate-700">{w.spotAtWindow.toFixed(0)}</p>
                    {w.dominantEvent && (
                      <p className="text-[9px] text-blue-600 mt-0.5 truncate">{w.dominantEvent.replace(/_/g, " ").toLowerCase()}</p>
                    )}
                    <div className="mt-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${w.anomalyScore}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Event sequence */}
          {move.preMoveEventSequence.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Precursor Sequence</p>
              <div className="flex flex-wrap gap-1">
                {move.preMoveEventSequence.map((e, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-100 text-blue-700 font-medium">
                    {e.replace(/_/g, " ").toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5 text-[10px] text-slate-500">
            <p><span className="font-semibold text-slate-700">Wall:</span> {move.wallBehaviorNote}</p>
            <p><span className="font-semibold text-slate-700">IV:</span> {move.ivBehaviorNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function PatternMatchCard({ match }: { match: PatternMatch }) {
  const isUp = match.pattern.moveDirection === "UP";
  const reliability = Math.round(match.pattern.reliabilityScore * 100);
  const similarity = Math.round(match.similarity * 100);

  return (
    <div className={`p-3 rounded-xl border ${similarity >= 85 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Star size={12} className={similarity >= 85 ? "text-amber-500" : "text-slate-300"} fill={similarity >= 85 ? "currentColor" : "none"} />
          <span className="text-xs font-bold text-slate-700">
            {similarity}% match · {isUp ? "▲" : "▼"} {match.pattern.moveMagnitude} pts
          </span>
        </div>
        <div>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            reliability >= 60 ? "bg-emerald-100 text-emerald-700" :
            reliability >= 40 ? "bg-amber-100 text-amber-700" :
            "bg-rose-100 text-rose-700"
          }`}>
            {reliability}% reliable
          </span>
        </div>
      </div>

      <p className="text-[10px] text-slate-500 mb-1">
        Based on {match.pattern.occurrenceCount} occurrences ({match.pattern.successCount} hits, {match.pattern.failureCount} misses) — last seen {match.pattern.moveDate}
      </p>

      {match.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {match.reasons.slice(0, 3).map((r, i) => (
            <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">{r}</span>
          ))}
        </div>
      )}

      {match.caveats.length > 0 && (
        <p className="text-[9px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-1 line-clamp-2">
          ⚠ {match.caveats[0]}
        </p>
      )}
    </div>
  );
}

export function PreMovePanel({ moves, patternMatches, loading }: PreMovePanelProps) {
  const [tab, setTab] = useState<"moves" | "patterns">("moves");

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Crosshair size={16} className="text-rose-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Pre-Move Forensics</span>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
          {(["moves", "patterns"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                tab === t ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t === "moves" ? `Moves (${moves.length})` : `Patterns (${patternMatches.length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[1,2].map(i => <div key={i} className="h-16 bg-slate-100 rounded-xl" />)}
        </div>
      ) : tab === "moves" ? (
        moves.length > 0 ? (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {moves.slice(0, 10).map(m => <MoveCard key={m.id} move={m} />)}
          </div>
        ) : (
          <p className="text-xs text-slate-400 text-center py-8">
            No significant moves detected yet. Requires {">"}40pt moves within 30 min.
          </p>
        )
      ) : (
        patternMatches.length > 0 ? (
          <div className="space-y-2">
            {patternMatches.slice(0, 5).map((m, i) => <PatternMatchCard key={i} match={m} />)}
          </div>
        ) : (
          <p className="text-xs text-slate-400 text-center py-8">
            No pattern matches yet — pattern library builds up after detecting several moves.
          </p>
        )
      )}
    </div>
  );
}
