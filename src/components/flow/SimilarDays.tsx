import { CalendarDays, TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react";

type RegimeLabel = string;

interface SimilarDay {
  date: string;
  similarity: number;
  matchingFeatures: string[];
  regime: RegimeLabel;
  outcome: { direction: "UP" | "DOWN" | "FLAT"; magnitude: number; regime: RegimeLabel };
  note: string;
}

interface SimilarDaysProps {
  similar: SimilarDay[];
  loading: boolean;
}

const REGIME_COLORS: Record<string, string> = {
  TREND_UP:              "text-emerald-700 bg-emerald-50 border-emerald-200",
  TREND_DOWN:            "text-rose-700 bg-rose-50 border-rose-200",
  RANGE_DAY:             "text-blue-700 bg-blue-50 border-blue-200",
  EXPIRY_PIN:            "text-violet-700 bg-violet-50 border-violet-200",
  SHORT_COVERING:        "text-teal-700 bg-teal-50 border-teal-200",
  LONG_UNWINDING:        "text-orange-700 bg-orange-50 border-orange-200",
  TRAP_HEAVY:            "text-amber-700 bg-amber-50 border-amber-200",
  HIGH_VOL_EVENT:        "text-red-700 bg-red-50 border-red-200",
  LOW_CONVICTION_CHURN:  "text-slate-600 bg-slate-50 border-slate-200",
  UNKNOWN:               "text-gray-500 bg-gray-50 border-gray-200",
};

const REGIME_LABELS: Record<string, string> = {
  TREND_UP: "Trend Up", TREND_DOWN: "Trend Down", RANGE_DAY: "Range Day",
  EXPIRY_PIN: "Expiry Pin", SHORT_COVERING: "Short Covering", LONG_UNWINDING: "Long Unwinding",
  TRAP_HEAVY: "Trap Heavy", HIGH_VOL_EVENT: "High Vol", LOW_CONVICTION_CHURN: "Low Conv.",
  UNKNOWN: "Unknown",
};

function SimilarityRing({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "text-emerald-600" : pct >= 70 ? "text-amber-600" : "text-slate-400";
  return (
    <div className="flex flex-col items-center">
      <span className={`text-lg font-bold tabular-nums ${color}`}>{pct}%</span>
      <span className="text-[9px] text-slate-400">similar</span>
    </div>
  );
}

export function SimilarDays({ similar, loading }: SimilarDaysProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Similar Sessions</span>
        </div>
        <div className="animate-pulse space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-20 bg-slate-100 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (similar.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Similar Sessions</span>
        </div>
        <p className="text-xs text-slate-400 text-center py-6">
          Similar days will appear after storing a few sessions (EOD signature needed).
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Similar Sessions</span>
        </div>
        <span className="text-[10px] text-slate-400">Pattern matching based on flow structure</span>
      </div>

      <div className="space-y-3">
        {similar.map((day, i) => {
          const regimeCls = REGIME_COLORS[day.regime] ?? REGIME_COLORS.UNKNOWN;
          const regimeLabel = REGIME_LABELS[day.regime] ?? day.regime;
          const outDir = day.outcome.direction;
          return (
            <div key={day.date} className="p-3 rounded-xl border border-slate-100 bg-slate-50 hover:bg-white transition-colors">
              <div className="flex items-start gap-3">
                {/* Rank + date */}
                <div className="shrink-0 text-center">
                  <span className="text-[10px] font-bold text-slate-400">#{i + 1}</span>
                  <p className="text-xs font-bold text-slate-700 tabular-nums mt-0.5">
                    {new Date(day.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                  </p>
                </div>

                {/* Similarity */}
                <div className="shrink-0">
                  <SimilarityRing value={day.similarity} />
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${regimeCls}`}>{regimeLabel}</span>
                    <ArrowRight size={9} className="text-slate-300" />
                    <span className={`flex items-center gap-0.5 text-[10px] font-bold ${
                      outDir === "UP" ? "text-emerald-700" : outDir === "DOWN" ? "text-rose-700" : "text-slate-500"
                    }`}>
                      {outDir === "UP" ? <TrendingUp size={10} /> : outDir === "DOWN" ? <TrendingDown size={10} /> : <Minus size={10} />}
                      {outDir === "FLAT" ? "Flat" : `${outDir === "UP" ? "+" : "-"}${day.outcome.magnitude} pts`}
                    </span>
                  </div>

                  <p className="text-[10px] text-slate-600 leading-relaxed mb-1.5 line-clamp-2">{day.note}</p>

                  {day.matchingFeatures.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {day.matchingFeatures.slice(0, 3).map((f, j) => (
                        <span key={j} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-100 text-blue-600">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
