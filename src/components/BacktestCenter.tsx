import { useMemo, useState } from "react";
import { Activity, BarChart2, Loader2, PlayCircle, TrendingUp, Zap } from "lucide-react";

type BacktestEvent = {
  id: string;
  isoTimestamp: string;
  timestamp: string;
  underlying: string;
  strike: number;
  side: "CE" | "PE" | "BOTH";
  type: "HIGH_VOLUME_EVENT" | "BEAR_TRAP_BUY_CE" | "BULL_TRAP_BUY_PE";
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  action: "WAIT" | "BUY_CE" | "BUY_PE";
  spot: number;
  eventHigh: number;
  eventLow: number;
  score: number;
  result?: "WIN" | "LOSS" | "NEUTRAL" | "OPEN";
  pnlPoints?: number;
  exitSpot?: number;
  exitIsoTimestamp?: string;
  reason: string;
  metrics: Record<string, any>;
};

type BacktestResult = {
  ok: boolean;
  source: string;
  params: Record<string, any>;
  rowsRead: number;
  strikesScanned: number;
  summary: {
    highVolumeEvents: number;
    confirmedTrades: number;
    buyCe: number;
    buyPe: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlPoints: number;
    avgPnlPoints: number;
  };
  events: BacktestEvent[];
  error?: string;
};

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function fmtNum(value: number | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "-";
  return value.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtInt(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return Math.round(value).toLocaleString("en-IN");
}

function resultClass(result?: string): string {
  if (result === "WIN") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (result === "LOSS") return "bg-rose-50 text-rose-700 border-rose-200";
  if (result === "NEUTRAL") return "bg-slate-50 text-slate-700 border-slate-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function typeLabel(type: BacktestEvent["type"]): string {
  if (type === "HIGH_VOLUME_EVENT") return "High Volume";
  if (type === "BEAR_TRAP_BUY_CE") return "Bear Trap CE";
  return "Bull Trap PE";
}

export function BacktestCenter() {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [date, setDate] = useState(todayIST());
  const [fromTime, setFromTime] = useState("09:15");
  const [toTime, setToTime] = useState("15:30");
  const [strike, setStrike] = useState("");
  const [targetPoints, setTargetPoints] = useState("25");
  const [trapWaitMinutes, setTrapWaitMinutes] = useState("5");
  const [minSamples, setMinSamples] = useState("80");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tradeEvents = useMemo(() => (result?.events || []).filter((e) => e.action !== "WAIT"), [result]);

  const runBacktest = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        underlying,
        date,
        fromTime,
        toTime,
        strike: strike.trim() || undefined,
        targetPoints,
        trapWaitMinutes,
        minSamples,
      };
      const res = await fetch("/api/flow-alerts/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: BacktestResult = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
    } catch (e: any) {
      setError(e.message || "Backtest failed");
    } finally {
      setLoading(false);
    }
  };

  const updateUnderlying = (value: string) => {
    setUnderlying(value);
    if (value === "NIFTY") setTargetPoints("25");
    if (value === "SENSEX") setTargetPoints("80");
    if (value === "BANKNIFTY") setTargetPoints("80");
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-600">
              <BarChart2 size={22} />
            </div>
            <div>
              <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">Flow Backtest</h2>
              <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
                Replay SD200 high-volume events, 5-minute trap validation, and CE/PE buy alerts.
              </p>
            </div>
          </div>
          <p className="text-xs text-dark/40 font-mono mt-2">
            Uses stored Neon bars. High volume fires immediately; BUY CE/PE is checked only after the validation window.
          </p>
        </div>
        <button
          onClick={runBacktest}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-blue text-white text-sm font-black shadow-lg hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
          Run Backtest
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3 bg-white border border-blue/10 rounded-3xl p-4 shadow-sm">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">Index</span>
          <select value={underlying} onChange={(e) => updateUnderlying(e.target.value)} className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold bg-white">
            <option>NIFTY</option>
            <option>SENSEX</option>
            <option>BANKNIFTY</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">From</span>
          <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)} className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">To</span>
          <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)} className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">Strike optional</span>
          <input value={strike} onChange={(e) => setStrike(e.target.value)} placeholder="All strikes" className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">Target pts</span>
          <input value={targetPoints} onChange={(e) => setTargetPoints(e.target.value)} className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-widest font-black text-dark/40">Wait / samples</span>
          <div className="grid grid-cols-2 gap-2">
            <input value={trapWaitMinutes} onChange={(e) => setTrapWaitMinutes(e.target.value)} title="Trap wait minutes" className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
            <input value={minSamples} onChange={(e) => setMinSamples(e.target.value)} title="Minimum SD samples" className="w-full border border-blue/15 rounded-xl px-3 py-2 text-sm font-bold" />
          </div>
        </label>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm font-bold">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Rows</div><div className="text-2xl font-black">{fmtInt(result.rowsRead)}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Strikes</div><div className="text-2xl font-black">{fmtInt(result.strikesScanned)}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">High Volume</div><div className="text-2xl font-black">{fmtInt(result.summary.highVolumeEvents)}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Trades</div><div className="text-2xl font-black">{fmtInt(result.summary.confirmedTrades)}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">BUY CE / PE</div><div className="text-2xl font-black">{result.summary.buyCe}/{result.summary.buyPe}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Win Rate</div><div className="text-2xl font-black">{fmtNum(result.summary.winRate, 1)}%</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Total Pts</div><div className="text-2xl font-black">{fmtNum(result.summary.totalPnlPoints, 1)}</div></div>
            <div className="rounded-2xl border border-blue/10 bg-white p-4 shadow-sm"><div className="text-[10px] uppercase text-dark/40 font-black">Source</div><div className="text-xs font-black truncate">{result.source}</div></div>
          </div>

          {result.events.length === 0 ? (
            <div className="rounded-3xl border border-amber-200 bg-amber-50 text-amber-800 px-5 py-4 text-sm font-bold">
              No SD200 high-volume event found for this period. Try all strikes, lower minimum samples, or select a date where stored bars are available.
            </div>
          ) : (
            <div className="bg-white border border-blue/10 rounded-3xl shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-blue/10">
                <Zap size={18} className="text-blue" />
                <h3 className="font-black uppercase tracking-tight">Backtest Events</h3>
                <span className="text-xs text-dark/40 font-mono">{result.events.length} events · {tradeEvents.length} trades</span>
              </div>
              <div className="overflow-x-auto max-h-[620px]">
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 border-b border-blue/10 z-10">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-dark/45">
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Event</th>
                      <th className="px-4 py-3 text-right">Strike</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3 text-right">Spot</th>
                      <th className="px-4 py-3 text-right">Range</th>
                      <th className="px-4 py-3 text-right">Vol Z</th>
                      <th className="px-4 py-3 text-right">Vol/SD</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3 text-right">Pts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.events.map((e) => (
                      <tr key={e.id} className={e.action === "WAIT" ? "bg-white" : "bg-blue/5"}>
                        <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{e.timestamp}</td>
                        <td className="px-4 py-3">
                          <div className="font-black text-dark">{typeLabel(e.type)}</div>
                          <div className="text-[11px] text-dark/45 max-w-xs truncate">{e.reason}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-black">{e.strike}</td>
                        <td className="px-4 py-3 font-bold">{e.side}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-1 rounded-lg text-[11px] font-black ${e.action === "BUY_CE" ? "bg-emerald-100 text-emerald-700" : e.action === "BUY_PE" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{e.action}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(e.spot)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs">H {fmtNum(e.eventHigh)} / L {fmtNum(e.eventLow)}</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(Math.max(e.metrics?.callVolZ || 0, e.metrics?.putVolZ || 0), 2)}</td>
                        <td className="px-4 py-3 text-right font-mono">{fmtNum(Math.max(e.metrics?.callVolRatio || 0, e.metrics?.putVolRatio || 0), 2)}</td>
                        <td className="px-4 py-3">
                          {e.result ? <span className={`inline-flex px-2 py-1 rounded-lg border text-[11px] font-black ${resultClass(e.result)}`}>{e.result}</span> : <span className="text-dark/30">-</span>}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-black ${(e.pnlPoints || 0) >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{e.pnlPoints == null ? "-" : fmtNum(e.pnlPoints, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-3xl border border-blue/10 bg-white p-4 text-xs text-dark/50 leading-relaxed">
            <div className="flex items-center gap-2 font-black text-dark mb-2"><Activity size={14} /> How this backtest reads signals</div>
            First row is the immediate high-volume information event. BUY CE/BUY PE appears only after the wait window if the event low/high is not broken and CE/PE flow confirms. Result is measured on spot points using the selected target and the event high/low as failure level.
          </div>
        </>
      )}
    </div>
  );
}
