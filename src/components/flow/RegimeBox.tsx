import { TrendingUp, TrendingDown, Minus, Activity, BarChart2, Wind, Clock, RefreshCw } from "lucide-react";

type RegimeLabel =
  | "TREND_UP" | "TREND_DOWN" | "RANGE_DAY" | "EXPIRY_PIN"
  | "SHORT_COVERING" | "LONG_UNWINDING" | "TRAP_HEAVY"
  | "HIGH_VOL_EVENT" | "LOW_CONVICTION_CHURN" | "UNKNOWN";

interface RegimeSummary {
  date: string;
  computedAt: string;
  regime: RegimeLabel;
  confidence: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  reasons: string[];
  eventCounts: Record<string, number>;
  breadthScore: number;
  directionalEfficiency: number;
  ivTrend: "EXPANDING" | "COMPRESSING" | "STABLE";
  priorRegime?: RegimeLabel;
  priorRegimeAt?: string;
}

interface RegimeBoxProps {
  regime: RegimeSummary | null;
  history: RegimeSummary[];
  loading: boolean;
}

const REGIME_META: Record<RegimeLabel, { label: string; color: string; bg: string; border: string }> = {
  TREND_UP:              { label: "Trend Up",         color: "text-emerald-700", bg: "bg-emerald-50",  border: "border-emerald-200" },
  TREND_DOWN:            { label: "Trend Down",        color: "text-rose-700",    bg: "bg-rose-50",     border: "border-rose-200"    },
  RANGE_DAY:             { label: "Range Day",         color: "text-blue-700",    bg: "bg-blue-50",     border: "border-blue-200"    },
  EXPIRY_PIN:            { label: "Expiry Pin",        color: "text-violet-700",  bg: "bg-violet-50",   border: "border-violet-200"  },
  SHORT_COVERING:        { label: "Short Covering",    color: "text-teal-700",    bg: "bg-teal-50",     border: "border-teal-200"    },
  LONG_UNWINDING:        { label: "Long Unwinding",    color: "text-orange-700",  bg: "bg-orange-50",   border: "border-orange-200"  },
  TRAP_HEAVY:            { label: "Trap Heavy",        color: "text-amber-700",   bg: "bg-amber-50",    border: "border-amber-200"   },
  HIGH_VOL_EVENT:        { label: "High Vol Event",    color: "text-red-700",     bg: "bg-red-50",      border: "border-red-200"     },
  LOW_CONVICTION_CHURN:  { label: "Low Conviction",    color: "text-slate-600",   bg: "bg-slate-50",    border: "border-slate-200"   },
  UNKNOWN:               { label: "Analysing…",        color: "text-gray-500",    bg: "bg-gray-50",     border: "border-gray-200"    },
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-slate-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

function DirectionalBar({ value }: { value: number }) {
  // value is -1 to +1; 0 = centre
  const pct = ((value + 1) / 2) * 100;
  const color = value > 0.15 ? "bg-emerald-500" : value < -0.15 ? "bg-rose-500" : "bg-slate-400";
  return (
    <div className="relative h-2 bg-slate-200 rounded-full overflow-hidden">
      {/* Centre line */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-400 z-10" />
      <div
        className={`absolute top-0 h-full rounded-full transition-all ${color}`}
        style={
          value >= 0
            ? { left: "50%", width: `${Math.abs(value) * 50}%` }
            : { right: "50%", width: `${Math.abs(value) * 50}%` }
        }
      />
    </div>
  );
}

function RegimePill({ regime, small = false }: { regime: RegimeLabel; small?: boolean }) {
  const meta = REGIME_META[regime] ?? REGIME_META.UNKNOWN;
  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${
      small ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs"
    } ${meta.color} ${meta.bg} ${meta.border}`}>
      {meta.label}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-10 bg-slate-200 rounded-xl w-40" />
      <div className="h-4 bg-slate-200 rounded w-3/4" />
      <div className="h-4 bg-slate-200 rounded w-1/2" />
      <div className="h-4 bg-slate-200 rounded w-2/3" />
    </div>
  );
}

export function RegimeBox({ regime, history, loading }: RegimeBoxProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Market Regime</span>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  if (!regime) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Market Regime</span>
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <RefreshCw size={14} className="animate-spin" />
          <span>Regime analysis running — waiting for market data…</span>
        </div>
      </div>
    );
  }

  const meta = REGIME_META[regime.regime] ?? REGIME_META.UNKNOWN;
  const updatedAgo = Math.round((Date.now() - new Date(regime.computedAt).getTime()) / 60000);

  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-5 ${meta.border}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Market Regime</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <Clock size={10} />
          <span>{updatedAgo < 2 ? "just now" : `${updatedAgo}m ago`}</span>
        </div>
      </div>

      {/* Main regime badge + confidence */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <RegimePill regime={regime.regime} />
          {regime.priorRegime && regime.priorRegime !== regime.regime && (
            <p className="text-[10px] text-slate-400 mt-1">
              Changed from <span className="font-medium">{REGIME_META[regime.priorRegime]?.label ?? regime.priorRegime}</span>
            </p>
          )}
        </div>
        {/* Bias indicator */}
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold ${
          regime.bias === "BULLISH" ? "bg-emerald-50 text-emerald-700" :
          regime.bias === "BEARISH" ? "bg-rose-50 text-rose-700" :
          "bg-slate-50 text-slate-600"
        }`}>
          {regime.bias === "BULLISH" ? <TrendingUp size={14} /> :
           regime.bias === "BEARISH" ? <TrendingDown size={14} /> :
           <Minus size={14} />}
          {regime.bias}
        </div>
      </div>

      {/* Confidence */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs text-slate-500 font-medium">Confidence</span>
        </div>
        <ConfidenceBar value={regime.confidence} />
      </div>

      {/* Directional efficiency */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs text-slate-500 font-medium">Directional Efficiency</span>
          <span className={`text-xs font-bold tabular-nums ${
            regime.directionalEfficiency > 0 ? "text-emerald-600" :
            regime.directionalEfficiency < 0 ? "text-rose-600" : "text-slate-500"
          }`}>
            {(regime.directionalEfficiency * 100).toFixed(0)}%
          </span>
        </div>
        <DirectionalBar value={regime.directionalEfficiency} />
        <div className="flex justify-between text-[9px] text-slate-400 mt-0.5">
          <span>Bear</span><span>Bull</span>
        </div>
      </div>

      {/* Breadth + IV row */}
      <div className="flex gap-4 mb-4">
        <div className="flex-1">
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs text-slate-500">Breadth</span>
            <span className="text-xs font-bold tabular-nums">{(regime.breadthScore * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${regime.breadthScore * 100}%` }}
            />
          </div>
        </div>
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium ${
          regime.ivTrend === "EXPANDING"   ? "bg-red-50 text-red-700 border border-red-100" :
          regime.ivTrend === "COMPRESSING" ? "bg-teal-50 text-teal-700 border border-teal-100" :
          "bg-slate-50 text-slate-600 border border-slate-100"
        }`}>
          <Wind size={11} />
          {regime.ivTrend === "EXPANDING" ? "IV ↑" : regime.ivTrend === "COMPRESSING" ? "IV ↓" : "IV Stable"}
        </div>
      </div>

      {/* Reasons */}
      {regime.reasons.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Why this regime</p>
          <ul className="space-y-1">
            {regime.reasons.slice(0, 4).map((r, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600">
                <span className="mt-1 shrink-0 w-1 h-1 rounded-full bg-slate-400" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* History strip */}
      {history.length > 1 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Recent history</p>
          <div className="flex flex-wrap gap-1">
            {history.slice(1, 8).map((h, i) => (
              <RegimePill key={i} regime={h.regime} small />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
