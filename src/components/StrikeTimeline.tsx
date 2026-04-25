import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, RefreshCw } from "lucide-react";

interface TimelineData {
  isoTimestamp?: string;
  timestamp: string;
  spot: string;
  call: {
    rawOI?: number;
    rawVol?: number;
    oi: number;
    coi: number;
    volDelta?: number;
    coiVolRatio: string;
    tqNtRatio: string;
    iv: string;
    ivRoc: string;
    ltp: string;
    premiumRoc: string;
  };
  put: {
    rawOI?: number;
    rawVol?: number;
    oi: number;
    coi: number;
    volDelta?: number;
    coiVolRatio: string;
    tqNtRatio: string;
    iv: string;
    ivRoc: string;
    ltp: string;
    premiumRoc: string;
  };
  reading: string;
}

const DEFAULT_STRIKES = [22000, 22100, 22200, 22300, 22400, 22500, 22600, 22700, 22800, 22900, 23000];
const IST = "Asia/Kolkata";

function p75(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.75);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function buildThresholds(timeline: TimelineData[]) {
  return {
    coi: p75(timeline.map((r) => r.call.coi).concat(timeline.map((r) => r.put.coi))),
    coiVol: p75(
      timeline.map((r) => parseFloat(r.call.coiVolRatio)).concat(
        timeline.map((r) => parseFloat(r.put.coiVolRatio))
      )
    ),
    tq: p75(
      timeline.map((r) => parseFloat(r.call.tqNtRatio)).concat(
        timeline.map((r) => parseFloat(r.put.tqNtRatio))
      )
    ),
    ivRoc: p75(
      timeline.map((r) => parseFloat(r.call.ivRoc)).concat(
        timeline.map((r) => parseFloat(r.put.ivRoc))
      )
    ),
    premRoc: p75(
      timeline.map((r) => parseFloat(r.call.premiumRoc)).concat(
        timeline.map((r) => parseFloat(r.put.premiumRoc))
      )
    ),
  };
}

function intenseBg(value: number, threshold: number, positive = true): string {
  if (threshold === 0 || Math.abs(value) <= threshold) return "";
  return positive
    ? (value > 0 ? "bg-emerald-100" : "bg-rose-100")
    : "bg-amber-100";
}

function formatRowTimestamp(row: TimelineData): string {
  if (row.isoTimestamp) {
    const d = new Date(row.isoTimestamp);
    const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
    const rowIST = d.toLocaleDateString("en-IN", { timeZone: IST });
    if (rowIST !== todayIST) {
      const dateLabel = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST });
      const timeLabel = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: IST });
      return `${dateLabel} ${timeLabel}`;
    }
  }
  return row.timestamp;
}

function toISTDate(isoTs: string): string {
  return new Date(isoTs).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", timeZone: IST,
  });
}

export function StrikeTimeline() {
  const [strikes, setStrikes] = useState<number[]>(DEFAULT_STRIKES);
  const [selectedStrike, setSelectedStrike] = useState(22500);
  const [timeline, setTimeline] = useState<TimelineData[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [strikeInput, setStrikeInput] = useState("");

  useEffect(() => {
    fetch("/api/option-chain")
      .then(async (res) => {
        if (!res.ok) return null;
        const ct = res.headers.get("content-type");
        if (!ct?.includes("application/json")) return null;
        return res.json();
      })
      .then((data) => {
        if (data?.currentWeek?.length > 0) {
          const liveStrikes: number[] = data.currentWeek
            .map((row: any) => row.strike)
            .sort((a: number, b: number) => a - b);

          if (liveStrikes.length > 0) {
            setStrikes(liveStrikes);
            const mid = liveStrikes[Math.floor(liveStrikes.length / 2)];
            setSelectedStrike(mid);
          }
        }
      })
      .catch(() => {});
  }, []);

  const fetchTimeline = async (strike: number) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/strike-timeline/${strike}`);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new TypeError("Server did not return JSON");
      }
      const data = await res.json();
      setTimeline(data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch timeline:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTimeline(selectedStrike);
    const interval = setInterval(() => fetchTimeline(selectedStrike), 180000);
    return () => clearInterval(interval);
  }, [selectedStrike]);

  const availableDates: string[] = (() => {
    const seen = new Set<string>();
    const dates: string[] = [];
    for (const row of timeline) {
      if (row.isoTimestamp) {
        const d = toISTDate(row.isoTimestamp);
        if (!seen.has(d)) {
          seen.add(d);
          dates.push(d);
        }
      }
    }
    return dates;
  })();

  const activeDate = selectedDate && availableDates.includes(selectedDate)
    ? selectedDate
    : availableDates[0] ?? "";

  const filteredTimeline = activeDate
    ? timeline.filter((row) => row.isoTimestamp && toISTDate(row.isoTimestamp) === activeDate)
    : timeline;

  const thresholds = buildThresholds(filteredTimeline);

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">3-Min Strike Timeline</h2>
          <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
            Real-time smart money tracking on specific strikes.
          </p>
          {timeline.length > 0 && (
            <p className="text-xs text-dark/40 font-mono mt-1">
              {filteredTimeline.length} bars shown · {timeline.length} total · 7-day backup active
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
            onClick={() => fetchTimeline(selectedStrike)}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-blue hover:border-blue/40 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
          </button>

          <div className="relative">
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="flex items-center gap-2 bg-white border border-blue/20 hover:border-blue/40 transition-colors px-5 py-2.5 rounded-xl text-dark font-mono font-bold shadow-sm"
            >
              {selectedStrike} CE/PE
              <ChevronDown size={16} className={`transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} />
            </button>

            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute right-0 mt-2 w-48 bg-white border border-blue/10 rounded-xl shadow-xl z-50 overflow-hidden"
                >
                  <div className="px-3 py-2 border-b border-blue/10">
                    <input
                      type="number"
                      value={strikeInput}
                      onChange={(e) => setStrikeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const val = parseInt(strikeInput);
                          if (val > 0) {
                            setSelectedStrike(val);
                            setIsDropdownOpen(false);
                            setStrikeInput("");
                          }
                        }
                      }}
                      placeholder="Type strike + Enter"
                      className="w-full text-sm font-mono border border-blue/20 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue text-dark placeholder:text-dark/30"
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {strikes.map((strike) => (
                      <button
                        key={strike}
                        onClick={() => {
                          setSelectedStrike(strike);
                          setIsDropdownOpen(false);
                        }}
                        className={`w-full text-left px-4 py-2 font-mono text-sm hover:bg-blue/5 transition-colors ${
                          selectedStrike === strike ? "text-blue font-bold bg-blue/10" : "text-dark/80 font-medium"
                        }`}
                      >
                        {strike}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

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

      <div className="overflow-x-auto border border-blue/20 shadow-lg bg-white/60 backdrop-blur-sm rounded-3xl">
        <div className="min-w-[1400px]">
          <table className="w-full text-right border-collapse font-sans">
            <thead>
              <tr className="bg-white text-dark/60 text-[9px] sm:text-[10px] font-bold border-b border-blue/10 uppercase tracking-tight leading-tight">
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-left border-r border-blue/5 align-bottom">Time</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />OI</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />COI</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom" title="Volume Delta">C<br />VΔ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />C/V</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom" title="TQ Lots">C<br />TQ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />IV</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />IVΔ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />LTP</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">C<br />PΔ</th>

                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-center border-r border-blue/5 text-blue align-bottom">
                  Spot
                </th>

                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />PΔ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />LTP</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />IVΔ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />IV</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom" title="TQ Lots">P<br />TQ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />C/V</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom" title="Volume Delta">P<br />VΔ</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />COI</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 border-r border-blue/5 align-bottom">P<br />OI</th>
                <th className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-left align-bottom">Read</th>
              </tr>
            </thead>

            <tbody className="text-[10px] sm:text-[11px] tracking-tight">
              {filteredTimeline.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={21} className="px-4 py-8 text-center text-dark/40 font-medium">
                    No data available. Connect your Upstox token to load live data.
                  </td>
                </tr>
              )}

              {filteredTimeline.map((row, i) => (
                <tr
                  key={`${row.timestamp}-${i}`}
                  className={`${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"} font-medium border-b border-blue/5 hover:bg-blue/5 transition-colors`}
                >
                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-left text-dark/80 font-mono whitespace-nowrap">
                    {formatRowTimestamp(row)}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-emerald-600 whitespace-nowrap">
                    {row.call.oi.toLocaleString("en-IN")}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap rounded-sm ${row.call.coi > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(row.call.coi, thresholds.coi)}`}>
                    {row.call.coi > 0 ? "+" : ""}{row.call.coi.toLocaleString("en-IN")}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/70 whitespace-nowrap">
                    {row.call.volDelta != null ? row.call.volDelta.toLocaleString("en-IN") : "—"}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.call.coiVolRatio), thresholds.coiVol, false)}`}>
                    {row.call.coiVolRatio}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.call.tqNtRatio), thresholds.tq, false)}`}>
                    {row.call.tqNtRatio}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap">
                    {row.call.iv}%
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap ${parseFloat(row.call.ivRoc) > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(parseFloat(row.call.ivRoc), thresholds.ivRoc, false)}`}>
                    {parseFloat(row.call.ivRoc) > 0 ? "+" : ""}{row.call.ivRoc}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-blue font-bold whitespace-nowrap">
                    {row.call.ltp}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap ${parseFloat(row.call.premiumRoc) > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(parseFloat(row.call.premiumRoc), thresholds.premRoc)}`}>
                    {parseFloat(row.call.premiumRoc) > 0 ? "+" : ""}{row.call.premiumRoc}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-center text-dark font-bold bg-blue/5 border-x border-blue/10 whitespace-nowrap">
                    {row.spot}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap ${parseFloat(row.put.premiumRoc) > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(parseFloat(row.put.premiumRoc), thresholds.premRoc)}`}>
                    {parseFloat(row.put.premiumRoc) > 0 ? "+" : ""}{row.put.premiumRoc}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-blue font-bold whitespace-nowrap">
                    {row.put.ltp}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap ${parseFloat(row.put.ivRoc) > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(parseFloat(row.put.ivRoc), thresholds.ivRoc, false)}`}>
                    {parseFloat(row.put.ivRoc) > 0 ? "+" : ""}{row.put.ivRoc}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap">
                    {row.put.iv}%
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.put.tqNtRatio), thresholds.tq, false)}`}>
                    {row.put.tqNtRatio}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/80 whitespace-nowrap ${intenseBg(parseFloat(row.put.coiVolRatio), thresholds.coiVol, false)}`}>
                    {row.put.coiVolRatio}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-dark/70 whitespace-nowrap">
                    {row.put.volDelta != null ? row.put.volDelta.toLocaleString("en-IN") : "—"}
                  </td>

                  <td className={`px-1 py-1.5 sm:px-1.5 sm:py-2 whitespace-nowrap ${row.put.coi > 0 ? "text-emerald-600" : "text-rose-600"} ${intenseBg(row.put.coi, thresholds.coi)}`}>
                    {row.put.coi > 0 ? "+" : ""}{row.put.coi.toLocaleString("en-IN")}
                  </td>

                  <td className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-emerald-600 whitespace-nowrap">
                    {row.put.oi.toLocaleString("en-IN")}
                  </td>

                  <td
                    className="px-1 py-1.5 sm:px-1.5 sm:py-2 text-left text-dark/80 max-w-[110px] sm:max-w-[130px] truncate"
                    title={row.reading}
                  >
                    {row.reading}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
