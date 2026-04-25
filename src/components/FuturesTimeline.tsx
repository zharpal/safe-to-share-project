import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";

interface FuturesBar {
  isoTimestamp: string;
  timestamp: string;
  instrumentKey: string;
  ltp: number;
  ltpChange: number;
  oi: number;
  coiBar: number;       // OI change vs previous bar
  volCum: number;       // cumulative daily volume
  volDelta: number;     // volume this bar period
  reading: string;
}

const IST = "Asia/Kolkata";
const NIFTY_LOT = 75; // Nifty futures lot size

function p75(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.75), sorted.length - 1)];
}

function buildThresholds(bars: FuturesBar[]) {
  return {
    coi:      p75(bars.map(r => r.coiBar)),
    volDelta: p75(bars.map(r => r.volDelta)),
    ltpChg:   p75(bars.map(r => r.ltpChange)),
  };
}

function intenseBg(val: number, threshold: number, directional = true): string {
  if (threshold === 0 || Math.abs(val) <= threshold) return "";
  return directional ? (val > 0 ? "bg-emerald-100" : "bg-rose-100") : "bg-amber-100";
}

function toISTDate(isoTs: string): string {
  return new Date(isoTs).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST });
}

function fmtTime(bar: FuturesBar): string {
  const d = new Date(bar.isoTimestamp);
  const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
  const barIST   = d.toLocaleDateString("en-IN", { timeZone: IST });
  if (barIST !== todayIST) {
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST })
      + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: IST });
  }
  return bar.timestamp;
}

function readingColor(reading: string): string {
  if (reading.includes("Bullish")) return "text-emerald-700 font-semibold";
  if (reading.includes("Bearish")) return "text-rose-700 font-semibold";
  return "text-dark/60";
}

export function FuturesTimeline() {
  const [bars, setBars]           = useState<FuturesBar[]>([]);
  const [isLoading, setLoading]   = useState(false);
  const [lastUpdated, setUpdated] = useState<Date | null>(null);
  const [selectedDate, setDate]   = useState<string>("");

  const fetchBars = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/futures-timeline");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FuturesBar[] = await res.json();
      setBars(data);
      setUpdated(new Date());
    } catch (err) {
      console.error("Futures timeline fetch failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBars();
    const id = setInterval(fetchBars, 180_000); // refresh every 3 min
    return () => clearInterval(id);
  }, []);

  // Unique IST dates, newest first (bars are newest-first from server)
  const availableDates: string[] = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of bars) {
      const d = toISTDate(b.isoTimestamp);
      if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
    return out;
  })();

  const activeDate = selectedDate && availableDates.includes(selectedDate)
    ? selectedDate
    : availableDates[0] ?? "";

  const filtered = activeDate
    ? bars.filter(b => toISTDate(b.isoTimestamp) === activeDate)
    : bars;

  const thr = buildThresholds(filtered);

  // Derive contract label from instrument key, e.g. NSE_FO|NIFTY26MARFUT → NIFTY MAR 26
  const contractLabel = bars[0]?.instrumentKey
    ? bars[0].instrumentKey.replace("NSE_FO|", "").replace(/([A-Z]+)(\d{2})([A-Z]+)FUT/, "$1 $3 $2")
    : "NIFTY Futures";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">Nifty Futures Timeline</h2>
          <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
            {contractLabel} · OI, Volume &amp; Price · 3-Min Bars
          </p>
          {bars.length > 0 && (
            <p className="text-xs text-dark/40 font-mono mt-1">
              {filtered.length} bars shown · {bars.length} total · lot size {NIFTY_LOT}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-dark/50 font-mono">
              {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button
            onClick={fetchBars}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-blue hover:border-blue/40 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Date filter tabs */}
      {availableDates.length >= 1 && (
        <div className="flex gap-2 flex-wrap">
          {availableDates.map(d => (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={`px-4 py-2 rounded-xl text-sm font-bold transition-all border ${
                activeDate === d
                  ? "bg-blue text-white border-blue shadow-md"
                  : "bg-white text-dark/70 border-blue/20 hover:border-blue/40 hover:text-dark"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto border border-blue/20 shadow-lg bg-white/60 backdrop-blur-sm rounded-3xl">
        <table className="w-full text-right border-collapse font-sans">
          <thead>
            <tr className="bg-white text-dark/60 text-[9px] sm:text-[10px] font-bold border-b border-blue/10 uppercase tracking-tighter leading-tight">
              <th className="px-2 py-3 text-left border-r border-blue/5 align-bottom">Time</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom text-blue">Futures<br/>LTP</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="LTP change vs previous bar">LTP<br/>Δ</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="Volume traded this 3-min bar">Vol Δ<br/>(contracts)</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="Volume delta in lots">Vol Δ<br/>(lots)</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="Total cumulative volume today">Cum Vol<br/>(L)</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="Open Interest in lots">OI<br/>(lots)</th>
              <th className="px-2 py-3 border-r border-blue/5 align-bottom" title="OI change vs previous bar (in lots)">OI Δ<br/>(lots)</th>
              <th className="px-2 py-3 text-left align-bottom">Reading</th>
            </tr>
          </thead>
          <tbody className="text-[10px] sm:text-[11px] tracking-tight">
            {filtered.length === 0 && !isLoading && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-dark/40 font-medium">
                  No futures data yet. Connect your Upstox token — data captures automatically during market hours (9:15 AM – 3:30 PM IST).
                </td>
              </tr>
            )}
            {filtered.map((bar, i) => {
              const oiLots    = Math.round(bar.oi / NIFTY_LOT);
              const coiLots   = Math.round(bar.coiBar / NIFTY_LOT);
              const volDeltaLots = Math.round(bar.volDelta / NIFTY_LOT);

              return (
                <tr
                  key={bar.isoTimestamp}
                  className={`${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"} font-medium border-b border-blue/5 hover:bg-blue/5 transition-colors`}
                >
                  <td className="px-2 py-2.5 text-left text-dark/80 font-mono whitespace-nowrap">{fmtTime(bar)}</td>

                  {/* LTP */}
                  <td className="px-2 py-2.5 text-blue font-bold whitespace-nowrap">
                    {bar.ltp.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>

                  {/* LTP Change */}
                  <td className={`px-2 py-2.5 whitespace-nowrap font-bold ${bar.ltpChange > 0 ? "text-emerald-600" : bar.ltpChange < 0 ? "text-rose-600" : "text-dark/40"} ${intenseBg(bar.ltpChange, thr.ltpChg)}`}>
                    {bar.ltpChange > 0 ? "+" : ""}{bar.ltpChange.toFixed(2)}
                  </td>

                  {/* Volume Delta (contracts) */}
                  <td className={`px-2 py-2.5 text-dark/70 whitespace-nowrap ${intenseBg(bar.volDelta, thr.volDelta, false)}`}>
                    {bar.volDelta > 0 ? (bar.volDelta / 1000).toFixed(1) + "K" : "—"}
                  </td>

                  {/* Volume Delta (lots) */}
                  <td className={`px-2 py-2.5 text-dark/70 whitespace-nowrap ${intenseBg(bar.volDelta, thr.volDelta, false)}`}>
                    {volDeltaLots > 0 ? volDeltaLots.toLocaleString("en-IN") : "—"}
                  </td>

                  {/* Cumulative Volume */}
                  <td className="px-2 py-2.5 text-dark/50 whitespace-nowrap">
                    {(bar.volCum / 100000).toFixed(2)} L
                  </td>

                  {/* OI in lots */}
                  <td className="px-2 py-2.5 text-dark/80 whitespace-nowrap">
                    {oiLots.toLocaleString("en-IN")}
                  </td>

                  {/* OI Change in lots */}
                  <td className={`px-2 py-2.5 whitespace-nowrap font-bold ${coiLots > 0 ? "text-emerald-600" : coiLots < 0 ? "text-rose-600" : "text-dark/40"} ${intenseBg(bar.coiBar, thr.coi)}`}>
                    {coiLots !== 0 ? (coiLots > 0 ? "+" : "") + coiLots.toLocaleString("en-IN") : "—"}
                  </td>

                  {/* Reading */}
                  <td className={`px-2 py-2.5 text-left whitespace-nowrap ${readingColor(bar.reading)}`}>
                    {bar.reading}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
