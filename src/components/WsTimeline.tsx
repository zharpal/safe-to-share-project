import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, RefreshCw, Zap, Clock } from "lucide-react";

interface BarData {
  isoTimestamp?: string;
  timestamp: string;
  spot: string;
  call: {
    oi: number; coi: number; volDelta?: number; coiVolRatio: string; tqNtRatio: string;
    iv: string; ivRoc: string; ltp: string; premiumRoc: string;
  };
  put: {
    oi: number; coi: number; volDelta?: number; coiVolRatio: string; tqNtRatio: string;
    iv: string; ivRoc: string; ltp: string; premiumRoc: string;
  };
  reading: string;
}

const DEFAULT_STRIKES = [22000,22100,22200,22300,22400,22500,22600,22700,22800,22900,23000];
const IST = "Asia/Kolkata";

// Market hours check (client-side mirror of server logic)
function isMarketOpen(): boolean {
  const parts = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour")!.value);
  const m = parseInt(parts.find(p => p.type === "minute")!.value);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function p75(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.75), sorted.length - 1)];
}
function buildThresholds(bars: BarData[]) {
  return {
    coi:     p75(bars.map(r => r.call.coi).concat(bars.map(r => r.put.coi))),
    coiVol:  p75(bars.map(r => parseFloat(r.call.coiVolRatio)).concat(bars.map(r => parseFloat(r.put.coiVolRatio)))),
    tq:      p75(bars.map(r => parseFloat(r.call.tqNtRatio)).concat(bars.map(r => parseFloat(r.put.tqNtRatio)))),
    ivRoc:   p75(bars.map(r => parseFloat(r.call.ivRoc)).concat(bars.map(r => parseFloat(r.put.ivRoc)))),
    premRoc: p75(bars.map(r => parseFloat(r.call.premiumRoc)).concat(bars.map(r => parseFloat(r.put.premiumRoc)))),
  };
}
function intenseBg(val: number, threshold: number, directional = true): string {
  if (threshold === 0 || Math.abs(val) <= threshold) return "";
  return directional ? (val > 0 ? "bg-emerald-100" : "bg-rose-100") : "bg-amber-100";
}
function fmtTime(row: BarData): string {
  if (row.isoTimestamp) {
    const d = new Date(row.isoTimestamp);
    const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
    const rowIST   = d.toLocaleDateString("en-IN", { timeZone: IST });
    if (rowIST !== todayIST) {
      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST })
        + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: IST });
    }
  }
  return row.timestamp;
}

function toISTDate(isoTs: string): string {
  return new Date(isoTs).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", timeZone: IST,
  });
}

export function WsTimeline() {
  const [strikes, setStrikes]           = useState<number[]>(DEFAULT_STRIKES);
  const [selectedStrike, setSelected]   = useState(22500);
  const [bars, setBars]                 = useState<BarData[]>([]);
  const [isDropdownOpen, setDropdown]   = useState(false);
  const [isLoading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);
  const [marketOpen, setMarketOpen]     = useState(isMarketOpen());
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [strikeInput, setStrikeInput]   = useState("");

  // Sync market-open state every 30 s
  useEffect(() => {
    const t = setInterval(() => setMarketOpen(isMarketOpen()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch("/api/option-chain")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.currentWeek?.length) {
          const live: number[] = data.currentWeek.map((r: any) => r.strike).sort((a: number, b: number) => a - b);
          if (live.length) { setStrikes(live); setSelected(live[Math.floor(live.length / 2)]); }
        }
      }).catch(() => {});
  }, []);

  const fetchBars = async (strike: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/live-timeline/${strike}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBars(data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Live timeline fetch failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBars(selectedStrike);
    // Poll every 60 s during market hours, every 5 min outside
    const interval = setInterval(() => fetchBars(selectedStrike), marketOpen ? 60_000 : 300_000);
    return () => clearInterval(interval);
  }, [selectedStrike, marketOpen]);

  // Compute unique IST dates from data, newest first
  const availableDates: string[] = (() => {
    const seen = new Set<string>();
    const dates: string[] = [];
    for (const row of bars) {
      if (row.isoTimestamp) {
        const d = toISTDate(row.isoTimestamp);
        if (!seen.has(d)) { seen.add(d); dates.push(d); }
      }
    }
    return dates;
  })();

  const activeDate = selectedDate && availableDates.includes(selectedDate)
    ? selectedDate
    : availableDates[0] ?? "";

  const filteredBars = activeDate
    ? bars.filter((row) => row.isoTimestamp && toISTDate(row.isoTimestamp) === activeDate)
    : bars;

  const thresholds = buildThresholds(filteredBars);

  return (
    <div className="p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">1-Min Live Feed</h2>
            <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
              marketOpen
                ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                : "bg-slate-100 text-slate-500 border border-slate-200"
            }`}>
              {marketOpen ? <Zap size={10} className="animate-pulse" /> : <Clock size={10} />}
              {marketOpen ? "Market Open · Live" : "Market Closed · Stored"}
            </span>
          </div>
          <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
            Premium &amp; IV signals · 1-minute bars · OI refreshes every ~3 min
          </p>
          {bars.length > 0 && (
            <p className="text-xs text-dark/40 font-mono mt-1">
              {filteredBars.length} bars shown · {bars.length} total
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
            onClick={() => fetchBars(selectedStrike)}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-blue hover:border-blue/40 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>

          <div className="relative">
            <button
              onClick={() => setDropdown(!isDropdownOpen)}
              className="flex items-center gap-2 bg-white border border-blue/20 hover:border-blue/40 transition-colors px-5 py-2.5 rounded-xl text-dark font-mono font-bold shadow-sm"
            >
              {selectedStrike} CE/PE
              <ChevronDown size={16} className={`transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
            </button>
            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                  className="absolute right-0 mt-2 w-48 bg-white border border-blue/10 rounded-xl shadow-xl z-50 overflow-hidden"
                >
                  {/* Type-in a custom strike */}
                  <div className="px-3 py-2 border-b border-blue/10">
                    <input
                      type="number"
                      value={strikeInput}
                      onChange={(e) => setStrikeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const val = parseInt(strikeInput);
                          if (val > 0) { setSelected(val); setDropdown(false); setStrikeInput(""); }
                        }
                      }}
                      placeholder="Type strike + Enter"
                      className="w-full text-sm font-mono border border-blue/20 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue text-dark placeholder:text-dark/30"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {strikes.map(s => (
                      <button key={s} onClick={() => { setSelected(s); setDropdown(false); }}
                        className={`w-full text-left px-4 py-2 font-mono text-sm hover:bg-blue/5 transition-colors ${
                          selectedStrike === s ? "text-blue font-bold bg-blue/10" : "text-dark/80 font-medium"
                        }`}>{s}</button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Date filter tabs */}
      {availableDates.length >= 1 && (
        <div className="flex gap-2 flex-wrap">
          {availableDates.map((d) => (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
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
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 text-left border-r border-blue/5 align-bottom">Time</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>OI</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>COI</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom" title="Volume traded this bar period">Call<br/>Vol Δ</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>COI/Vol</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>TQ(L)</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>IV</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>IV ROC</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>LTP</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Call<br/>Prem ROC</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 text-center border-r border-blue/5 text-blue align-bottom">Spot<br/>Price</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>Prem ROC</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>LTP</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>IV ROC</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>IV</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>TQ(L)</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>COI/Vol</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom" title="Volume traded this bar period">Put<br/>Vol Δ</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>COI</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 border-r border-blue/5 align-bottom">Put<br/>OI</th>
              <th className="px-1.5 py-2 sm:px-2 sm:py-3 text-left align-bottom">Reading</th>
            </tr>
          </thead>
          <tbody className="text-[10px] sm:text-[11px] tracking-tight">
            {filteredBars.length === 0 && !isLoading && (
              <tr>
                <td colSpan={21} className="px-4 py-8 text-center text-dark/40 font-medium">
                  {marketOpen
                    ? "Waiting for first bar… connect your Upstox token."
                    : "Market is closed. Stored bars will appear here during 9:15 AM – 3:30 PM IST."}
                </td>
              </tr>
            )}
            {filteredBars.map((row, i) => (
              <tr key={`${row.timestamp}-${i}`}
                className={`${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"} font-medium border-b border-blue/5 hover:bg-blue/5 transition-colors`}>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-left text-dark/80 font-mono whitespace-nowrap">{fmtTime(row)}</td>

                {/* Call */}
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-emerald-600 whitespace-nowrap">{(row.call.oi/100000).toFixed(2)} L</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${row.call.coi>0?"text-emerald-600":"text-rose-600"} ${intenseBg(row.call.coi,thresholds.coi)}`}>
                  {row.call.coi>0?"+":""}{(row.call.coi/1000).toFixed(2)} K</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/70 whitespace-nowrap">
                  {row.call.volDelta != null ? (row.call.volDelta/1000).toFixed(1)+"K" : "—"}</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.call.coiVolRatio),thresholds.coiVol,false)}`}>{row.call.coiVolRatio}%</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.call.tqNtRatio),thresholds.tq,false)}`}>{row.call.tqNtRatio}</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap">{row.call.iv}%</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${parseFloat(row.call.ivRoc)>0?"text-emerald-600":"text-rose-600"} ${intenseBg(parseFloat(row.call.ivRoc),thresholds.ivRoc,false)}`}>
                  {parseFloat(row.call.ivRoc)>0?"+":""}{row.call.ivRoc}</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-blue font-bold whitespace-nowrap">{row.call.ltp}</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${parseFloat(row.call.premiumRoc)>0?"text-emerald-600":"text-rose-600"} ${intenseBg(parseFloat(row.call.premiumRoc),thresholds.premRoc)}`}>
                  {parseFloat(row.call.premiumRoc)>0?"+":""}{row.call.premiumRoc}</td>

                {/* Spot */}
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-center text-dark font-bold bg-blue/5 border-x border-blue/10 whitespace-nowrap">{row.spot}</td>

                {/* Put */}
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${parseFloat(row.put.premiumRoc)>0?"text-emerald-600":"text-rose-600"} ${intenseBg(parseFloat(row.put.premiumRoc),thresholds.premRoc)}`}>
                  {parseFloat(row.put.premiumRoc)>0?"+":""}{row.put.premiumRoc}</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-blue font-bold whitespace-nowrap">{row.put.ltp}</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${parseFloat(row.put.ivRoc)>0?"text-emerald-600":"text-rose-600"} ${intenseBg(parseFloat(row.put.ivRoc),thresholds.ivRoc,false)}`}>
                  {parseFloat(row.put.ivRoc)>0?"+":""}{row.put.ivRoc}</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap">{row.put.iv}%</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.put.tqNtRatio),thresholds.tq,false)}`}>{row.put.tqNtRatio}</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.put.coiVolRatio),thresholds.coiVol,false)}`}>{row.put.coiVolRatio}%</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-dark/70 whitespace-nowrap">
                  {row.put.volDelta != null ? (row.put.volDelta/1000).toFixed(1)+"K" : "—"}</td>
                <td className={`px-1.5 py-2 sm:px-2 sm:py-2.5 whitespace-nowrap ${row.put.coi>0?"text-emerald-600":"text-rose-600"} ${intenseBg(row.put.coi,thresholds.coi)}`}>
                  {row.put.coi>0?"+":""}{(row.put.coi/1000).toFixed(2)} K</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-emerald-600 whitespace-nowrap">{(row.put.oi/100000).toFixed(2)} L</td>
                <td className="px-1.5 py-2 sm:px-2 sm:py-2.5 text-left text-dark/80 max-w-[120px] sm:max-w-[150px] truncate" title={row.reading}>{row.reading}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
