import { useState, useEffect, ChangeEvent } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TrendPoint { label: string; net: number | null; change: number | null; }

interface ParticipantRow {
  participant: string;
  longsChange: number;
  shortsChange: number;
  longsAction: string;
  shortsAction: string;
  netToday: number;
  net1dAgo: number;
  netChange: number;
  tradeAction: string;
  sentiment: "bullish" | "bearish" | "neutral";
  trend5d: TrendPoint[];
  streak: { days: number; direction: number };
}

interface Segment {
  name: string;
  isPuts: boolean;
  rows: ParticipantRow[];
  totalLongsChange: number;
  totalShortsChange: number;
}

interface EodData {
  date: string;
  trendDates: string[];
  segments: Segment[];
  verdict: string;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtNet(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 10_00_000) return sign + (a / 10_00_000).toFixed(2) + " Cr";
  if (a >= 1_00_000)  return sign + (a / 1_00_000).toFixed(2) + " L";
  if (a >= 1_000)     return sign + (a / 1_000).toFixed(1) + " K";
  return n.toLocaleString("en-IN");
}

function fmtDelta(n: number): string {
  const a = Math.abs(n);
  const sign = n >= 0 ? "+" : "−";
  if (a >= 1_00_000) return sign + (a / 1_00_000).toFixed(2) + "L";
  if (a >= 1_000)    return sign + (a / 1_000).toFixed(1) + "K";
  return (n >= 0 ? "+" : "−") + a.toLocaleString("en-IN");
}

function fmtAbs(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_00_000) return (a / 1_00_000).toFixed(2) + "L";
  if (a >= 1_000)    return (a / 1_000).toFixed(1) + "K";
  return a.toLocaleString("en-IN");
}

// ── Colour helpers ────────────────────────────────────────────────────────────
const P_COLOR: Record<string, string> = {
  FIIs: "text-violet-700", DIIs: "text-sky-700",
  PROs: "text-orange-600", Clients: "text-rose-600",
};
const P_BG: Record<string, string> = {
  FIIs: "bg-violet-50", DIIs: "bg-sky-50",
  PROs: "bg-orange-50", Clients: "bg-rose-50",
};
const P_BORDER: Record<string, string> = {
  FIIs: "border-violet-300", DIIs: "border-sky-300",
  PROs: "border-orange-300", Clients: "border-rose-300",
};

function sentimentCls(s: string) {
  return s === "bullish" ? "bg-emerald-100 text-emerald-800 border-emerald-300"
       : s === "bearish" ? "bg-rose-100 text-rose-800 border-rose-300"
       : "bg-slate-100 text-slate-500 border-slate-300";
}

// ── 5-day sparkline (pure CSS, no chart lib) ──────────────────────────────────
function Sparkline({ trend5d, isPuts }: { trend5d: TrendPoint[]; isPuts: boolean }) {
  const nets = trend5d.map(t => t.net ?? 0);
  const max  = Math.max(...nets.map(Math.abs), 1);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {trend5d.map((pt, i) => {
        if (pt.net === null) return <div key={i} className="w-4 bg-slate-100 rounded-sm h-1" />;
        const height = Math.max(4, Math.round((Math.abs(pt.net) / max) * 28));
        // Determine if this bar is "good" (moving in bullish direction for that segment)
        const isGood = isPuts ? pt.net < 0 : pt.net > 0;
        const cls = isGood ? "bg-emerald-400" : "bg-rose-400";
        const isToday = i === trend5d.length - 1;
        return (
          <div
            key={i}
            title={`${pt.label}: ${fmtNet(pt.net)} (${pt.change !== null ? fmtDelta(pt.change) : "—"})`}
            className={`w-4 rounded-sm transition-all ${cls} ${isToday ? "opacity-100 ring-1 ring-offset-0 ring-slate-400" : "opacity-60"}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

// ── Streak badge ──────────────────────────────────────────────────────────────
function StreakBadge({ streak, isPuts }: { streak: { days: number; direction: number }; isPuts: boolean }) {
  if (streak.days < 2) return null;
  const isBullish = isPuts ? streak.direction < 0 : streak.direction > 0;
  const cls = isBullish ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800";
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${cls}`}>
      {streak.days}d streak {isBullish ? "↑" : "↓"}
    </span>
  );
}

// ── SECTION 1 — The Verdict card ──────────────────────────────────────────────
function VerdictCard({ verdict, date, fiiRow }: { verdict: string; date: string; fiiRow: ParticipantRow }) {
  const isNetShort = fiiRow.netToday < 0;
  const isGettingMoreBearish = fiiRow.netChange < 0;
  const borderCls = isNetShort ? "border-rose-400" : "border-emerald-400";
  const bgCls     = isNetShort ? "bg-rose-50"      : "bg-emerald-50";
  const headerCls = isNetShort ? "bg-rose-600"     : "bg-emerald-700";

  return (
    <div className={`rounded-2xl border-2 ${borderCls} overflow-hidden shadow-md`}>
      <div className={`${headerCls} text-white px-5 py-3 flex items-center justify-between`}>
        <div>
          <p className="text-[10px] uppercase tracking-widest font-bold opacity-80">FII Index Futures · {date}</p>
          <p className="text-xl font-extrabold tracking-tight mt-0.5">
            {isNetShort ? "🐻 FIIs are NET SHORT" : "🐂 FIIs are NET LONG"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-extrabold">{fmtNet(fiiRow.netToday)}</p>
          <p className="text-[11px] opacity-80">net contracts</p>
        </div>
      </div>
      <div className={`${bgCls} px-5 py-4 space-y-3`}>
        {/* Today's activity */}
        <div className="flex flex-wrap gap-3 text-sm">
          <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-slate-200">
            <span className={`font-bold ${fiiRow.longsChange >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
              {fiiRow.longsAction}
            </span>
            <span className="font-mono font-bold text-slate-800">{fmtAbs(fiiRow.longsChange)}</span>
            <span className="text-slate-400 text-[11px]">longs</span>
          </div>
          <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 border border-slate-200">
            <span className={`font-bold ${fiiRow.shortsChange >= 0 ? "text-rose-700" : "text-emerald-700"}`}>
              {fiiRow.shortsAction}
            </span>
            <span className="font-mono font-bold text-slate-800">{fmtAbs(fiiRow.shortsChange)}</span>
            <span className="text-slate-400 text-[11px]">shorts</span>
          </div>
          <div className={`flex items-center gap-2 bg-white rounded-xl px-3 py-2 border ${isGettingMoreBearish ? "border-rose-300" : "border-emerald-300"}`}>
            <span className="text-slate-500 text-[11px]">Net change today:</span>
            <span className={`font-mono font-extrabold ${isGettingMoreBearish ? "text-rose-700" : "text-emerald-700"}`}>
              {fmtDelta(fiiRow.netChange)}
            </span>
            <span className="text-[11px] font-semibold text-slate-600">
              {isGettingMoreBearish ? "← more bearish" : "← more bullish"}
            </span>
          </div>
        </div>
        {/* Plain-English verdict */}
        <p className="text-[13px] text-slate-700 leading-relaxed font-medium">{verdict}</p>
      </div>
    </div>
  );
}

// ── SECTION 2 — Positioning Matrix ───────────────────────────────────────────
// Rows = participants, columns = segments. Each cell = net OI + today's Δ + sentiment.
function PositioningMatrix({ segments }: { segments: Segment[] }) {
  const PARTICIPANTS = ["FIIs", "DIIs", "PROs", "Clients"];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="bg-slate-800 text-white px-5 py-3">
        <p className="font-extrabold text-base">Positioning Matrix — at a glance</p>
        <p className="text-slate-400 text-[11px] mt-0.5">
          Net OI = Long OI − Short OI · Green = net long (bullish) · Red = net short (bearish) · Arrow = today's direction change
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-left text-[11px] uppercase tracking-wider font-bold text-slate-500 w-28">Participant</th>
              {segments.map(s => (
                <th key={s.name} className="px-3 py-3 text-center text-[11px] uppercase tracking-wider font-bold text-slate-500">
                  <div>{s.name}</div>
                  <div className="text-[9px] font-normal text-slate-400 normal-case mt-0.5">
                    {s.name === "Index Puts" ? "Long puts = bearish" : "Net long = bullish"}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {PARTICIPANTS.map((pName, pi) => (
              <tr key={pName} className={pi % 2 === 0 ? "bg-white" : "bg-slate-50/40"}>
                {/* Participant label */}
                <td className={`px-4 py-4 font-extrabold text-sm ${P_COLOR[pName]} ${P_BG[pName]} border-r border-slate-100`}>
                  {pName}
                </td>
                {/* One cell per segment */}
                {segments.map(seg => {
                  const row = seg.rows.find(r => r.participant === pName);
                  if (!row) return <td key={seg.name} className="px-3 py-4 text-center text-slate-300">—</td>;

                  const netPositive = row.netToday >= 0;
                  // For puts: net positive = bearish (holding protection)
                  const isBullishCell = seg.isPuts ? row.netToday < 0 : row.netToday > 0;
                  const bgCell = isBullishCell ? "bg-emerald-50" : row.netToday === 0 ? "" : "bg-rose-50";
                  const textCell = isBullishCell ? "text-emerald-800" : row.netToday === 0 ? "text-slate-500" : "text-rose-800";
                  const arrow = row.netChange === 0 ? "→" : row.netChange > 0 ? (seg.isPuts ? "↑🔴" : "↑🟢") : (seg.isPuts ? "↓🟢" : "↓🔴");

                  return (
                    <td key={seg.name} className={`px-3 py-4 text-center ${bgCell}`}>
                      <div className={`font-mono font-extrabold text-sm ${textCell}`}>
                        {netPositive ? "" : "−"}{fmtAbs(Math.abs(row.netToday))}
                      </div>
                      <div className="flex items-center justify-center gap-1 mt-1">
                        <span className="text-[10px] font-bold text-slate-500">{fmtDelta(row.netChange)}</span>
                        <span className="text-[11px]">{arrow}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Legend */}
      <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100 flex flex-wrap gap-4 text-[10px] text-slate-500">
        <span>🟢 ↑ = position becoming more bullish</span>
        <span>🔴 ↓ = position becoming more bearish</span>
        <span>For Index Puts: ↑ net = more protection held = more bearish</span>
      </div>
    </div>
  );
}

// ── SECTION 3 — 5-day trend per participant for Index Futures ─────────────────
function TrendPanel({ segments }: { segments: Segment[] }) {
  const idxFut = segments.find(s => s.name === "Index Futures")!;
  const PARTICIPANTS = ["FIIs", "DIIs", "PROs", "Clients"];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="bg-slate-800 text-white px-5 py-3">
        <p className="font-extrabold text-base">5-Day Net Position Trend — Index Futures</p>
        <p className="text-slate-400 text-[11px] mt-0.5">
          Bar height = absolute net OI · Green = net long · Red = net short · Last bar = today
        </p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-slate-200">
        {PARTICIPANTS.map(pName => {
          const row = idxFut.rows.find(r => r.participant === pName)!;
          if (!row) return null;
          return (
            <div key={pName} className={`px-5 py-4 space-y-3 ${P_BG[pName]}`}>
              <div className="flex items-center justify-between">
                <p className={`font-extrabold text-sm ${P_COLOR[pName]}`}>{pName}</p>
                <StreakBadge streak={row.streak} isPuts={false} />
              </div>
              <Sparkline trend5d={row.trend5d} isPuts={false} />
              {/* Last 5 days as mini numbers */}
              <div className="space-y-0.5">
                {[...row.trend5d].reverse().map((pt, i) => {
                  if (pt.net === null) return null;
                  const isToday = i === 0;
                  return (
                    <div key={i} className={`flex justify-between text-[10px] ${isToday ? "font-bold text-slate-800" : "text-slate-400"}`}>
                      <span>{pt.label || "—"}</span>
                      <span className={pt.net >= 0 ? "text-emerald-600" : "text-rose-600"}>
                        {fmtNet(pt.net)}
                        {pt.change !== null && i > 0 && (
                          <span className="ml-1 text-slate-400">({fmtDelta(pt.change)})</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── SECTION 4 — Smart money vs retail divergence ──────────────────────────────
function DivergenceCard({ segments }: { segments: Segment[] }) {
  const idxFut = segments.find(s => s.name === "Index Futures")!;
  const fii     = idxFut.rows.find(r => r.participant === "FIIs")!;
  const clients = idxFut.rows.find(r => r.participant === "Clients")!;
  if (!fii || !clients) return null;

  const diverged = Math.sign(fii.netToday) !== Math.sign(clients.netToday);
  const fiiShort  = fii.netToday < 0;
  const retLong   = clients.netToday > 0;

  return (
    <div className={`rounded-2xl border-2 overflow-hidden shadow-sm ${diverged ? "border-amber-400" : "border-slate-200"}`}>
      <div className={`px-5 py-3 flex items-center gap-3 ${diverged ? "bg-amber-50" : "bg-slate-50"}`}>
        <span className="text-2xl">{diverged ? "⚠️" : "✅"}</span>
        <div>
          <p className={`font-extrabold text-sm ${diverged ? "text-amber-800" : "text-slate-700"}`}>
            {diverged ? "Smart Money vs Retail — DIVERGENCE detected" : "Smart Money vs Retail — Aligned"}
          </p>
          <p className="text-[11px] text-slate-500">
            {diverged
              ? `FIIs are net ${fiiShort ? "SHORT" : "LONG"} while retail clients are net ${retLong ? "LONG" : "SHORT"} in Index Futures. When they diverge, FIIs are historically right.`
              : `FIIs and retail clients are both net ${fii.netToday > 0 ? "LONG" : "SHORT"} in Index Futures. Aligned positioning.`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-slate-200 bg-white">
        {[fii, clients].map(row => (
          <div key={row.participant} className={`px-5 py-4 ${P_BG[row.participant]}`}>
            <p className={`text-[11px] font-bold uppercase tracking-wider ${P_COLOR[row.participant]}`}>{row.participant}</p>
            <p className={`text-2xl font-extrabold mt-1 ${row.netToday >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
              {fmtNet(row.netToday)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Today: <span className={row.netChange >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>{fmtDelta(row.netChange)}</span>
              {" "}→ {row.netChange >= 0 ? "buying" : "selling"} pressure
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SECTION 5 — Detailed tables (collapsible) ─────────────────────────────────
function DetailedTables({ segments, date }: { segments: Segment[]; date: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3 bg-slate-100 hover:bg-slate-200 text-left flex items-center justify-between transition-colors"
      >
        <span className="font-bold text-slate-700 text-sm">Full OI Detail Tables (all segments × all participants)</span>
        <span className="text-slate-500">{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <div className="space-y-5 p-5 bg-white">
          {segments.map(seg => (
            <div key={seg.name} className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="bg-slate-700 text-white px-4 py-2.5 flex items-baseline gap-3">
                <span className="font-extrabold text-sm">{seg.name}</span>
                <span className="text-slate-400 text-[11px]">{date}</span>
                {seg.isPuts && <span className="text-amber-300 text-[10px]">★ For puts: net long = bearish hedge; net short = bullish (selling puts)</span>}
              </div>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b">
                    <th className="px-3 py-2 text-left font-bold">Participant</th>
                    <th className="px-3 py-2 text-left font-bold text-emerald-700">Longs</th>
                    <th className="px-3 py-2 text-right font-bold text-emerald-700">Δ</th>
                    <th className="px-3 py-2 text-left font-bold text-rose-700">Shorts</th>
                    <th className="px-3 py-2 text-right font-bold text-rose-700">Δ</th>
                    <th className="px-3 py-2 text-right font-bold border-l border-slate-200">Net OI Today</th>
                    <th className="px-3 py-2 text-right font-bold text-slate-400">1d ago</th>
                    <th className="px-3 py-2 text-right font-bold border-l border-slate-200">Today Δ</th>
                    <th className="px-3 py-2 text-center font-bold">Action</th>
                    <th className="px-3 py-2 text-center font-bold">Bias</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {seg.rows.map((r, i) => (
                    <tr key={r.participant} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/40"}>
                      <td className={`px-3 py-2.5 font-extrabold ${P_COLOR[r.participant]} ${P_BG[r.participant]}`}>{r.participant}</td>
                      <td className={`px-3 py-2.5 text-[11px] font-semibold ${r.longsChange >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{r.longsAction}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold ${r.longsChange >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{fmtAbs(r.longsChange)}</td>
                      <td className={`px-3 py-2.5 text-[11px] font-semibold ${r.shortsChange >= 0 ? "text-rose-600" : "text-emerald-600"}`}>{r.shortsAction}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold ${r.shortsChange >= 0 ? "text-rose-600" : "text-emerald-600"}`}>{fmtAbs(r.shortsChange)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold border-l border-slate-100 ${r.netToday >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtNet(r.netToday)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-400">{fmtNet(r.net1dAgo)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono font-bold border-l border-slate-100 ${r.netChange >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtDelta(r.netChange)}</td>
                      <td className={`px-3 py-2.5 text-center text-[10px] font-bold uppercase ${r.tradeAction === "bought net" ? "text-emerald-700" : "text-rose-700"}`}>{r.tradeAction}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${sentimentCls(r.sentiment)}`}>{r.sentiment}</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-100 border-t-2 border-slate-300 text-[10px] font-bold text-slate-500">
                    <td className="px-3 py-2">Total</td>
                    <td colSpan={2} className={`px-3 py-2 text-right font-mono ${seg.totalLongsChange >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtDelta(seg.totalLongsChange)}</td>
                    <td colSpan={2} className={`px-3 py-2 text-right font-mono ${seg.totalShortsChange >= 0 ? "text-rose-700" : "text-emerald-700"}`}>{fmtDelta(seg.totalShortsChange)}</td>
                    <td colSpan={5} />
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Context cheat-sheet (collapsed) ──────────────────────────────────────────
function ContextGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-amber-200 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3 bg-amber-50 hover:bg-amber-100 text-left flex items-center justify-between"
      >
        <span className="font-bold text-amber-800 text-sm">📖 How to read this for trading decisions</span>
        <span className="text-amber-600 text-[11px]">{open ? "▲ hide" : "▼ show"}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-3 bg-amber-50 text-[12px] text-slate-700 space-y-4 leading-relaxed">
          <div>
            <p className="font-extrabold text-slate-800 mb-1">FII Index Futures — the #1 signal</p>
            <ul className="space-y-1 list-disc list-inside ml-1">
              <li><strong>Market went UP + FIIs added shorts</strong> → They used the rally to build bearish bets. <span className="text-rose-700 font-bold">Strong bearish conviction.</span> Treat any further rally as distribution.</li>
              <li><strong>Market went UP + FIIs closed shorts</strong> → They're reducing bearish bets. <span className="text-slate-600 font-bold">Less conviction.</span> Short squeeze possible.</li>
              <li><strong>Market went DOWN + FIIs added longs</strong> → Buying the dip. <span className="text-emerald-700 font-bold">Bullish conviction</span>, expect recovery.</li>
              <li><strong>Market went DOWN + FIIs closed longs</strong> → Reducing exposure, not clear direction yet. Wait for confirmation.</li>
            </ul>
          </div>
          <div>
            <p className="font-extrabold text-slate-800 mb-1">FII Index Puts — hedging signal</p>
            <ul className="space-y-1 list-disc list-inside ml-1">
              <li><strong>FIIs net LONG puts (positive net)</strong> → They're holding protection/insurance. Expecting a possible fall even if they seem neutral in futures.</li>
              <li><strong>FIIs net SHORT puts (negative net)</strong> → They're selling puts = confident market won't fall much. Bullish signal.</li>
            </ul>
          </div>
          <div>
            <p className="font-extrabold text-slate-800 mb-1">FII vs Retail divergence</p>
            <p>When FIIs are net short and retail clients are net long in index futures — this is a classic setup. FIIs have better information and deeper pockets. In this divergence, <strong>follow FIIs</strong>.</p>
          </div>
          <div>
            <p className="font-extrabold text-slate-800 mb-1">Streak matters</p>
            <p>A single day of FII short-adding could be hedging. 3+ consecutive days of adding shorts = structural bearish view. Check the 5-day trend bar.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CSV Upload panel (shown when auto-fetch fails) ────────────────────────────
// NSE blocks server-side requests. Workaround: user downloads CSV in browser,
// uploads it here → server caches to disk permanently.
function UploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle");
  const [errDetail, setErrDetail] = useState<{ msg: string; hint?: string; preview?: string } | null>(null);

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    setErrDetail(null);
    for (const file of Array.from(e.target.files) as File[]) {
      setStatus("uploading");
      try {
        const text = await file.text();
        const m = file.name.match(/(\d{8})/);
        const hdrs: Record<string, string> = { "Content-Type": "text/plain" };
        if (m) hdrs["x-nse-date"] = m[1];
        const res = await fetch("/api/eod-participants/upload", { method: "POST", body: text, headers: hdrs });
        const json = await res.json();
        if (!res.ok) {
          setStatus("err");
          setErrDetail({ msg: json.error || "Upload failed", hint: json.hint, preview: json.preview });
          return;
        }
      } catch (err: any) {
        setStatus("err");
        setErrDetail({ msg: err.message });
        return;
      }
    }
    setStatus("ok");
    setTimeout(onUploaded, 600);
  }

  const isHtmlError = errDetail?.msg?.includes("HTML page");

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-5">
      <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 overflow-hidden">
        <div className="bg-amber-500 text-white px-5 py-3">
          <p className="font-extrabold text-base">NSE Archive — Manual Upload Required</p>
          <p className="text-amber-100 text-[11px] mt-0.5">NSE blocks server-side requests. Download the CSV in your browser and upload it here.</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          {/* Step-by-step */}
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500 text-white flex items-center justify-center font-extrabold text-[11px]">1</span>
              <div>
                <p className="font-bold text-slate-800">Click a date link below — your browser will download the file automatically</p>
                <p className="text-slate-500 text-[11px] mt-0.5">
                  If it opens as text in the browser instead of downloading, press <kbd className="bg-slate-200 px-1 rounded text-[10px]">Ctrl+S</kbd> and save as <code>fao_participant_oi_DDMMYYYY.csv</code> (keep the original filename).
                </p>
                <p className="text-rose-600 text-[11px] font-bold mt-1">
                  ⚠️ Do NOT use "Save page as" → "Web page HTML" — you must save as plain text / CSV only.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500 text-white flex items-center justify-center font-extrabold text-[11px]">2</span>
              <div>
                <p className="font-bold text-slate-800">Open the downloaded file in a text editor to verify</p>
                <p className="text-slate-500 text-[11px]">First line should be: <code className="bg-slate-100 px-1 rounded">Client Type,Future Index Contracts Long,...</code><br />If it starts with <code>&lt;html&gt;</code> — the date is not published yet.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500 text-white flex items-center justify-center font-extrabold text-[11px]">3</span>
              <div>
                <p className="font-bold text-slate-800">Upload all 5 files at once for full trend data</p>
              </div>
            </li>
          </ol>

          {/* Error detail */}
          {errDetail && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 space-y-1.5">
              <p className="font-bold text-rose-700 text-sm">Upload failed</p>
              <p className="text-rose-600 text-[12px]">{errDetail.msg}</p>
              {isHtmlError && (
                <div className="text-[12px] text-slate-700 bg-white rounded-lg px-3 py-2 border border-rose-200 space-y-1">
                  <p className="font-bold">What to check:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-slate-600">
                    <li>Did your browser save an HTML page instead of the raw CSV?</li>
                    <li>NSE publishes data after market close (~16:00–17:00 IST). If you're downloading today's file before 5 PM, it won't exist yet.</li>
                    <li>Try a previous date (23 Mar, 20 Mar) first to confirm the format works.</li>
                  </ul>
                </div>
              )}
              {errDetail.hint && <p className="text-slate-500 text-[11px] font-mono">{errDetail.hint}</p>}
              {errDetail.preview && (
                <details className="text-[10px]">
                  <summary className="cursor-pointer text-slate-500">Show first 300 chars of received file</summary>
                  <pre className="mt-1 bg-white border border-slate-200 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all text-slate-600">{errDetail.preview}</pre>
                </details>
              )}
            </div>
          )}

          {/* Upload button */}
          <div className="pt-2">
            <label className={`inline-flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-sm cursor-pointer transition-colors
              ${status === "uploading" ? "bg-slate-300 text-slate-500 cursor-wait"
               : status === "ok" ? "bg-emerald-500 text-white"
               : "bg-amber-500 hover:bg-amber-600 text-white"}`}>
              {status === "uploading" ? "⏳ Uploading…"
               : status === "ok" ? "✅ Done — reloading…"
               : "📂 Choose CSV file(s) to upload"}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                multiple
                className="hidden"
                disabled={status === "uploading"}
                onChange={handleChange}
              />
            </label>
            {status === "ok" && <p className="mt-2 text-[12px] font-semibold text-emerald-700">Uploaded — loading dashboard…</p>}
          </div>
        </div>
      </div>

      {/* Quick date links for last 5 trading days */}
      <div className="bg-white rounded-xl border border-slate-200 px-5 py-4">
        <p className="font-bold text-slate-700 text-sm mb-3">Quick links — last 5 trading days (open each, save as CSV, upload above)</p>
        <div className="flex flex-wrap gap-2">
          {(function() {
            const links = [];
            let d = new Date();
            let count = 0;
            while (count < 5) {
              const day = d.getDay();
              if (day !== 0 && day !== 6) {
                const dd = String(d.getDate()).padStart(2, "0");
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const yyyy = d.getFullYear();
                const key = `${dd}${mm}${yyyy}`;
                const label = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
                links.push(
                  <a
                    key={key}
                    href={`https://archives.nseindia.com/content/nsccl/fao_participant_oi_${key}.csv`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[11px] font-bold border border-blue-200 transition-colors"
                  >
                    {label} ↗
                  </a>
                );
                count++;
              }
              d.setDate(d.getDate() - 1);
            }
            return links;
          })()}
        </div>
        <p className="text-slate-400 text-[10px] mt-2">After first upload, data is cached on disk — you only need to upload once per day.</p>
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
export function ParticipantDataView() {
  const [data, setData]     = useState<EodData | null>(null);
  const [error, setError]   = useState<string>("");
  const [loading, setLoading] = useState(true);

  function loadData() {
    setLoading(true);
    setError("");
    fetch("/api/eod-participants")
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        return res.json();
      })
      .then((d: EodData) => { setData(d); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }

  useEffect(() => { loadData(); }, []);

  if (loading) return <div className="p-8 text-blue-600 animate-pulse font-bold">Loading NSE Participant OI Data…</div>;
  if (error || !data) return <UploadPanel onUploaded={loadData} />;

  const fiiIdxFutRow = data.segments[0].rows.find(r => r.participant === "FIIs")!;

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-baseline gap-3">
        <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">EOD Participants</h2>
        <span className="text-sm font-bold text-slate-400">{data.date} · NSE F&O Participant OI</span>
      </div>

      {/* 1. The Verdict */}
      <VerdictCard verdict={data.verdict} date={data.date} fiiRow={fiiIdxFutRow} />

      {/* 2. Divergence */}
      <DivergenceCard segments={data.segments} />

      {/* 3. Positioning matrix */}
      <PositioningMatrix segments={data.segments} />

      {/* 4. 5-day trend */}
      <TrendPanel segments={data.segments} />

      {/* 5. Context guide */}
      <ContextGuide />

      {/* 6. Detailed tables (collapsed) */}
      <DetailedTables segments={data.segments} date={data.date} />
    </div>
  );
}
