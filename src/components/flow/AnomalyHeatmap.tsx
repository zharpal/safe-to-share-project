import { Zap } from "lucide-react";

type FlowEventType =
  | "FRESH_WRITING" | "SHORT_COVERING" | "LONG_BUILDUP" | "LONG_UNWINDING"
  | "CHURN" | "WALL_CREATION" | "WALL_MIGRATION" | "LIQUIDITY_SWEEP"
  | "ABSORPTION" | "IV_SHOCK" | "EXPIRY_PIN";

interface AnomalyEntry {
  strike: number;
  anomalyScore: number;
  dominantType: FlowEventType;
  confidence: number;
  explanation: string;
  callZScore: number;
  putZScore: number;
}

interface AnomalyHeatmapProps {
  anomalies: AnomalyEntry[];
  loading: boolean;
}

const TYPE_META: Record<FlowEventType, { label: string; color: string; bg: string }> = {
  FRESH_WRITING:   { label: "Writing",   color: "text-blue-700",   bg: "bg-blue-100"   },
  SHORT_COVERING:  { label: "S.Cover",   color: "text-teal-700",   bg: "bg-teal-100"   },
  LONG_BUILDUP:    { label: "Buildup",   color: "text-emerald-700",bg: "bg-emerald-100"},
  LONG_UNWINDING:  { label: "Unwind",    color: "text-orange-700", bg: "bg-orange-100" },
  CHURN:           { label: "Churn",     color: "text-slate-600",  bg: "bg-slate-100"  },
  WALL_CREATION:   { label: "Wall",      color: "text-violet-700", bg: "bg-violet-100" },
  WALL_MIGRATION:  { label: "Migration", color: "text-indigo-700", bg: "bg-indigo-100" },
  LIQUIDITY_SWEEP: { label: "Sweep",     color: "text-rose-700",   bg: "bg-rose-100"   },
  ABSORPTION:      { label: "Absorb",    color: "text-amber-700",  bg: "bg-amber-100"  },
  IV_SHOCK:        { label: "IV Shock",  color: "text-red-700",    bg: "bg-red-100"    },
  EXPIRY_PIN:      { label: "Pin",       color: "text-purple-700", bg: "bg-purple-100" },
};

function heatColor(score: number): string {
  if (score >= 80) return "bg-red-500";
  if (score >= 60) return "bg-orange-400";
  if (score >= 40) return "bg-amber-300";
  return "bg-slate-200";
}

function ZScoreBar({ value, label }: { value: number; label: string }) {
  const abs = Math.min(3, Math.abs(value));
  const pct = (abs / 3) * 100;
  const color = value > 0 ? "bg-blue-400" : "bg-rose-400";
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] text-slate-400 w-5 text-right">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[9px] tabular-nums w-7 text-right font-medium ${value > 1.5 ? "text-red-600" : value < -1.5 ? "text-rose-600" : "text-slate-500"}`}>
        {value > 0 ? "+" : ""}{value.toFixed(1)}σ
      </span>
    </div>
  );
}

export function AnomalyHeatmap({ anomalies, loading }: AnomalyHeatmapProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <Zap size={16} className="text-amber-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Anomaly Leaderboard</span>
        </div>
        <div className="animate-pulse space-y-2">
          {[1,2,3,4,5].map(i => <div key={i} className="h-12 bg-slate-100 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (anomalies.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={16} className="text-amber-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Anomaly Leaderboard</span>
        </div>
        <p className="text-xs text-slate-400 text-center py-6">
          No significant anomalies detected yet. Engine computes after each capture.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-amber-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Anomaly Leaderboard</span>
        </div>
        <span className="text-[10px] text-slate-400">Top {anomalies.length} strikes by z-score</span>
      </div>

      {/* Heat strip */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {anomalies.map(a => (
          <div
            key={a.strike}
            title={`${a.strike}: ${a.anomalyScore}`}
            className="flex flex-col items-center gap-0.5 shrink-0"
          >
            <div
              className={`w-8 rounded-sm transition-all ${heatColor(a.anomalyScore)}`}
              style={{ height: `${Math.max(8, a.anomalyScore * 0.4)}px` }}
            />
            <span className="text-[8px] text-slate-500 tabular-nums">{a.strike}</span>
          </div>
        ))}
      </div>

      {/* Ranked list */}
      <div className="space-y-2">
        {anomalies.slice(0, 8).map((a, rank) => {
          const meta = TYPE_META[a.dominantType] ?? TYPE_META.CHURN;
          return (
            <div key={a.strike} className="p-3 rounded-xl border border-slate-100 bg-slate-50 hover:bg-white transition-colors">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-400 w-3">#{rank + 1}</span>
                  <span className="text-sm font-bold text-slate-800 tabular-nums">{a.strike.toLocaleString("en-IN")}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.color} ${meta.bg}`}>
                    {meta.label}
                  </span>
                </div>
                {/* Score badge */}
                <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white ${heatColor(a.anomalyScore)}`}>
                  {a.anomalyScore}
                </div>
              </div>

              {/* Z-score bars */}
              <div className="space-y-0.5 mb-2">
                <ZScoreBar value={a.callZScore} label="CE" />
                <ZScoreBar value={a.putZScore}  label="PE" />
              </div>

              <p className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">{a.explanation}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
