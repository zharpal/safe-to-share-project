import React, { useState, useEffect, useRef } from "react";
import {
  Brain, RefreshCw, TrendingUp, TrendingDown, Minus,
  ChevronDown, ChevronUp, AlertTriangle, Zap, Target,
  Eye, Clock, Shield, BookOpen, Download, Upload, CheckCircle2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EodStrikeEntry {
  strike: number;
  label: string; // "ATM", "ATM+100", "ATM-200" etc
  callActivity: string;
  putActivity: string;
  likelyParticipant: string;
  whatHappened: string;
  significance: "HIGH" | "MEDIUM" | "LOW";
}

interface EodStrikeSummary {
  date: string;
  niftySpot: number;
  atm: number;
  generatedAt: string;
  overallNarrative: string;
  strikes: EodStrikeEntry[];
}

interface StrikePrediction {
  index: "NIFTY" | "SENSEX";
  strike: number;
  type: "CE" | "PE";
  participant: "FIIs" | "PROs" | "DIIs";
  activity: string;
  simpleExplanation: string;
  entryPremium: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  predictedDate: string;
  premiumHistory: Array<{ date: string; premium: number }>;
  status: "ACTIVE" | "STOPPED";
  analysisDate?: string;
}

interface DailyAIMemory {
  date: string;
  generatedAt: string;
  bias: "BULLISH" | "BEARISH" | "SIDEWAYS";
  confidence: string;
  narrative: string;
  trapAlert: string;
  nextDayPlan: string;
  watchlist: StrikePrediction[];
  keyLevels: { support: number[]; resistance: number[] };
  reasoning: string;
}

interface EodAnalysisResponse {
  latest: DailyAIMemory;
  history: DailyAIMemory[];
}

interface ParticipantRow {
  participant: string;
  netToday: number;
  netChange: number;
  sentiment: "bullish" | "bearish" | "neutral";
}

interface EodParticipantsData {
  date: string;
  verdict: string;
  segments: Array<{
    name: string;
    isPuts: boolean;
    rows: ParticipantRow[];
  }>;
}

interface HistoryStatus {
  total: number;
  dates: string[];
  dateRange: { from: string; to: string } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "+";
  if (a >= 10_00_000) return s + (a / 10_00_000).toFixed(1) + " Cr";
  if (a >= 1_00_000)  return s + (a / 1_00_000).toFixed(1) + " L";
  if (a >= 1_000)     return s + (a / 1_000).toFixed(1) + "K";
  return (n >= 0 ? "+" : "−") + a.toLocaleString("en-IN");
}

const PARTICIPANT_COLOR: Record<string, { dot: string; text: string; bg: string; border: string }> = {
  FIIs:    { dot: "bg-violet-500", text: "text-violet-700", bg: "bg-violet-50",  border: "border-violet-200" },
  PROs:    { dot: "bg-orange-500", text: "text-orange-700", bg: "bg-orange-50",  border: "border-orange-200" },
  DIIs:    { dot: "bg-sky-500",    text: "text-sky-700",    bg: "bg-sky-50",     border: "border-sky-200"    },
  Clients: { dot: "bg-rose-500",   text: "text-rose-700",   bg: "bg-rose-50",    border: "border-rose-200"   },
};

const ACTIVITY_COLOR: Record<string, string> = {
  "Call Writing": "text-red-600 bg-red-50 border-red-200",
  "Put Writing":  "text-emerald-600 bg-emerald-50 border-emerald-200",
  "Call Buying":  "text-emerald-600 bg-emerald-50 border-emerald-200",
  "Put Buying":   "text-red-600 bg-red-50 border-red-200",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function BiasBadge({ bias, confidence }: { bias: string; confidence: string }) {
  const upper = (bias || "").toUpperCase();
  const conf  = confidence ? ` · ${confidence}` : "";
  if (upper === "BULLISH") return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-emerald-100 border border-emerald-300 text-emerald-800 rounded-full font-bold text-sm">
      <TrendingUp size={14} /> Bullish{conf}
    </span>
  );
  if (upper === "BEARISH") return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-red-100 border border-red-300 text-red-800 rounded-full font-bold text-sm">
      <TrendingDown size={14} /> Bearish{conf}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-amber-100 border border-amber-300 text-amber-800 rounded-full font-bold text-sm">
      <Minus size={14} /> Sideways{conf}
    </span>
  );
}

/** Mini premium sparkline — shows how a predicted premium moved over 7 days */
function PremiumSparkline({ history }: { history: Array<{ date: string; premium: number }> }) {
  if (history.length < 2) return <span className="text-xs text-dark/40 font-mono">—</span>;
  const first = history[0].premium;
  return (
    <div className="flex items-center gap-1">
      {history.map((h, i) => {
        const pct = first > 0 ? h.premium / first : 1;
        const isLast = i === history.length - 1;
        // For call/put writing — premium falling is GOOD (position working)
        const color = h.premium < first ? "bg-emerald-400" : h.premium > first ? "bg-red-400" : "bg-slate-300";
        const barH  = Math.max(4, Math.min(24, Math.round(pct * 16)));
        return (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <div
              className={`w-3 rounded-sm ${color} ${isLast ? "ring-1 ring-slate-400" : "opacity-70"}`}
              style={{ height: barH }}
              title={`${h.date}: ₹${h.premium}`}
            />
          </div>
        );
      })}
      <span className="text-xs font-mono text-dark/60 ml-1">
        ₹{history[history.length - 1].premium.toFixed(1)}
      </span>
    </div>
  );
}

/** One row for the Glossary / legend */
function GlossaryRow({ term, meaning }: { term: string; meaning: string }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="font-bold text-dark/80 shrink-0 w-28">{term}</span>
      <span className="text-dark/60">{meaning}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function SmartMoneyAI() {
  const [analysis, setAnalysis]       = useState<EodAnalysisResponse | null>(null);
  const [loadingAnalysis, setLoading] = useState(true);
  const [triggering, setTriggering]   = useState(false);
  const [triggerMsg, setTriggerMsg]   = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showGlossary,  setShowGlossary]  = useState(false);
  const [eodData, setEodData]           = useState<EodParticipantsData | null>(null);
  const [loadingEod, setLoadingEod]     = useState(true);
  const [strikeSummary, setStrikeSummary] = useState<EodStrikeSummary | null>(null);
  const [triggeringSummary, setTriggeringSummary] = useState(false);
  // Data management
  const [histStatus, setHistStatus]   = useState<HistoryStatus | null>(null);
  const [fetching, setFetching]       = useState(false);
  const [fetchMsg, setFetchMsg]       = useState<string | null>(null);
  const [uploading, setUploading]     = useState(false);
  const [uploadMsg, setUploadMsg]     = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchAnalysis();
    fetchEodSnapshot();
    fetchHistStatus();
    fetchStrikeSummary();
  }, []);

  function fetchStrikeSummary() {
    fetch("/api/ai/eod-strike-summary")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.latest) setStrikeSummary(d.latest); })
      .catch(() => {});
  }

  async function triggerStrikeSummary() {
    setTriggeringSummary(true);
    try {
      await fetch("/api/ai/eod-strike-summary", { method: "POST" });
      // Poll for result
      let attempts = 0;
      const poll = setInterval(() => {
        fetchStrikeSummary();
        if (++attempts > 8) { clearInterval(poll); setTriggeringSummary(false); }
      }, 5000);
    } catch { setTriggeringSummary(false); }
  }

  function fetchAnalysis() {
    setLoading(true);
    fetch("/api/ai/eod-analysis")
      .then(r => r.ok ? r.json() : null)
      .then(d => { setAnalysis(d); setLoading(false); })
      .catch(() => setLoading(false));
  }

  function fetchEodSnapshot() {
    setLoadingEod(true);
    fetch("/api/eod-participants")
      .then(r => r.ok ? r.json() : null)
      .then(d => { setEodData(d); setLoadingEod(false); fetchHistStatus(); })
      .catch(() => setLoadingEod(false));
  }

  function fetchHistStatus() {
    fetch("/api/eod-participants/history-status")
      .then(r => r.ok ? r.json() : null)
      .then(d => setHistStatus(d))
      .catch(() => {});
  }

  async function autoFetch() {
    setFetching(true);
    setFetchMsg("Fetching last 7 days from NSE archives…");
    try {
      await fetch("/api/eod-participants/auto-fetch", { method: "POST" });
      // Poll history status for up to 30s
      let attempts = 0;
      const poll = setInterval(() => {
        fetchHistStatus();
        if (++attempts > 6) {
          clearInterval(poll);
          setFetching(false);
          setFetchMsg(null);
          fetchAnalysis();
        }
      }, 5000);
    } catch (e: any) {
      setFetchMsg("Fetch failed: " + e.message);
      setFetching(false);
    }
  }

  async function handleManualUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const text = await file.text();
      // Detect date from filename (e.g. fao_participant_oi_28032026.csv → datekey=28032026)
      const dateMatch = file.name.match(/(\d{8})/);
      const url = dateMatch
        ? `/api/eod-participants/upload?date=${dateMatch[1]}`
        : "/api/eod-participants/upload";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadMsg("Upload failed: " + (data.error || "unknown error"));
      } else {
        setUploadMsg(`Uploaded successfully (${data.rows} rows)`);
        fetchHistStatus();
        fetchAnalysis();
      }
    } catch (err: any) {
      setUploadMsg("Error: " + err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function triggerAnalysis() {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      const r = await fetch("/api/ai/eod-analysis", { method: "POST" });
      const d = await r.json();
      setTriggerMsg(d.message || d.error || "Started.");
      if (r.ok) {
        // Poll every 10 s for up to 2 min
        let attempts = 0;
        const poll = setInterval(() => {
          fetch("/api/ai/eod-analysis")
            .then(r2 => r2.ok ? r2.json() : null)
            .then(d2 => {
              if (d2 && (!analysis || d2.latest?.generatedAt !== analysis.latest?.generatedAt)) {
                setAnalysis(d2);
                setTriggering(false);
                setTriggerMsg(null);
                clearInterval(poll);
              }
            });
          if (++attempts > 12) { setTriggering(false); clearInterval(poll); }
        }, 10000);
      } else {
        setTriggering(false);
      }
    } catch (e: any) {
      setTriggerMsg(e.message);
      setTriggering(false);
    }
  }

  const latest = analysis?.latest ?? null;

  // Collect all watchlist entries from last 7 days (across analyses)
  const watchlistEntries: (StrikePrediction & { analysisDate: string })[] = [];
  if (analysis?.history) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    for (const mem of analysis.history) {
      if (new Date(mem.date) < cutoff) continue;
      for (const w of mem.watchlist) {
        watchlistEntries.push({ ...w, analysisDate: mem.date });
      }
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="bg-violet-100 p-2.5 rounded-xl border border-violet-200">
            <Brain className="text-violet-600" size={22} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-dark">Smart Money Intelligence</h2>
            <p className="text-xs text-dark/50 mt-0.5">
              DeepSeek R1 · Cross-references 3-min strike timeline + EOD participant data · Learns from its own track record
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowGlossary(v => !v)}
            className="flex items-center gap-1.5 text-xs text-dark/50 hover:text-blue border border-dark/10 hover:border-blue/40 px-3 py-1.5 rounded-lg transition-colors"
          >
            <BookOpen size={12} /> {showGlossary ? "Hide" : "Show"} Terms
          </button>
          <button
            onClick={triggerAnalysis}
            disabled={triggering}
            className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-xl border transition-all
              ${triggering
                ? "bg-violet-100 text-violet-400 border-violet-200 cursor-not-allowed"
                : "bg-violet-600 hover:bg-violet-700 text-white border-transparent shadow-sm"}`}
          >
            <Brain size={14} className={triggering ? "animate-pulse" : ""} />
            {triggering ? "Analysing…" : "Run Analysis Now"}
          </button>
          <button onClick={fetchAnalysis} className="text-dark/40 hover:text-blue transition-colors p-2 rounded-lg hover:bg-blue/5">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {triggerMsg && (
        <div className={`text-xs rounded-xl px-4 py-2.5 border ${triggerMsg.toLowerCase().includes("error") || triggerMsg.toLowerCase().includes("failed") ? "text-red-700 bg-red-50 border-red-200" : "text-violet-700 bg-violet-50 border-violet-200"}`}>
          {triggerMsg}
        </div>
      )}

      {/* ── EOD Data Panel ─────────────────────────────────────────────────── */}
      <div className="bg-white border border-blue/15 rounded-2xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: status */}
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <span className="text-xs font-bold text-dark">EOD Participant Data</span>
              {histStatus ? (
                <span className="text-xs text-dark/50 mt-0.5">
                  {histStatus.total > 0
                    ? <><span className="text-emerald-600 font-semibold">{histStatus.total} days</span> stored · {histStatus.dateRange?.from} → {histStatus.dateRange?.to}</>
                    : <span className="text-amber-600">No data yet</span>}
                </span>
              ) : (
                <span className="text-xs text-dark/30 animate-pulse">checking…</span>
              )}
            </div>
            {histStatus && histStatus.total > 0 && (
              <div className="flex gap-1 flex-wrap">
                {histStatus.dates.slice(-7).map(d => (
                  <span key={d} className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 px-1.5 py-0.5 rounded font-mono">
                    {d}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Auto-fetch from NSE */}
            <button
              onClick={autoFetch}
              disabled={fetching}
              className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-all ${
                fetching
                  ? "bg-blue/5 text-blue/40 border-blue/20 cursor-not-allowed"
                  : "bg-blue/5 hover:bg-blue/10 text-blue border-blue/20"
              }`}
              title="Fetch last 7 trading days from NSE archives automatically"
            >
              <Download size={12} className={fetching ? "animate-bounce" : ""} />
              {fetching ? "Fetching NSE…" : "Auto-Fetch 7 Days"}
            </button>

            {/* Manual CSV upload */}
            <label className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border cursor-pointer transition-all ${
              uploading
                ? "bg-dark/3 text-dark/30 border-dark/10 cursor-not-allowed"
                : "bg-dark/3 hover:bg-dark/8 text-dark/60 border-dark/15"
            }`} title="Upload NSE participant OI CSV manually">
              <Upload size={12} />
              {uploading ? "Uploading…" : "Upload CSV"}
              <input
                ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                onChange={handleManualUpload} disabled={uploading}
              />
            </label>
          </div>
        </div>

        {/* Status messages */}
        {fetchMsg && (
          <p className="mt-2 text-xs text-blue/70 flex items-center gap-1.5">
            <RefreshCw size={11} className="animate-spin" /> {fetchMsg}
          </p>
        )}
        {uploadMsg && (
          <p className={`mt-2 text-xs flex items-center gap-1.5 ${uploadMsg.includes("success") ? "text-emerald-600" : "text-red-600"}`}>
            <CheckCircle2 size={11} /> {uploadMsg}
          </p>
        )}

        {/* Help text */}
        <p className="text-xs text-dark/35 mt-2 leading-relaxed">
          <strong>Auto-Fetch</strong> pulls directly from NSE archives (free, no login needed) ·
          <strong> Upload CSV</strong> if NSE is unavailable — download <code className="bg-dark/5 px-1 rounded">fao_participant_oi_DDMMYYYY.csv</code> from nseindia.com
        </p>
      </div>

      {/* ── Glossary (for beginners) ────────────────────────────────────────── */}
      {showGlossary && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-2">
          <p className="text-xs font-bold text-amber-800 mb-3">Quick Glossary — What These Terms Mean</p>
          <GlossaryRow term="FIIs" meaning="Big foreign investors (Goldman Sachs, JPMorgan etc.). They usually know what's coming." />
          <GlossaryRow term="PROs / PropDesk" meaning="Brokers trading their own firm's money. Very smart, usually hedge with options." />
          <GlossaryRow term="Net Long (+)" meaning="They hold more BUY positions than SELL — they expect market to go UP." />
          <GlossaryRow term="Net Short (−)" meaning="They hold more SELL positions than BUY — they expect market to go DOWN." />
          <GlossaryRow term="Call Writing" meaning="Selling call options. Acts as a CEILING — they don't expect market to cross that strike." />
          <GlossaryRow term="Put Writing" meaning="Selling put options. Acts as a FLOOR — they don't expect market to fall below that strike." />
          <GlossaryRow term="Call Buying" meaning="Buying calls. They expect a strong rally UP." />
          <GlossaryRow term="Put Buying" meaning="Buying puts. They expect a fall, or are protecting their positions." />
          <GlossaryRow term="OI (Open Interest)" meaning="Total outstanding contracts at a strike. More OI = more action and importance at that level." />
        </div>
      )}

      {/* ── Today's Participant Snapshot ────────────────────────────────────── */}
      <div className="bg-white border border-blue/15 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-blue/10 bg-blue/3">
          <div className="flex items-center gap-2">
            <Eye size={15} className="text-blue" />
            <span className="text-sm font-bold text-dark">Today's Participant Snapshot</span>
            {eodData && (
              <span className="text-xs text-dark/40 bg-dark/5 px-2 py-0.5 rounded-full">{eodData.date}</span>
            )}
          </div>
          <button onClick={fetchEodSnapshot} className="text-dark/30 hover:text-blue transition-colors">
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="p-5">
          {loadingEod ? (
            <p className="text-xs text-dark/40 animate-pulse">Fetching from NSE…</p>
          ) : !eodData ? (
            <p className="text-xs text-amber-700">
              Participant data not available — NSE may not have published today's file yet (published after 6 PM).
            </p>
          ) : (
            <div className="space-y-4">
              {/* Verdict in plain English */}
              <p className="text-sm text-dark/80 leading-relaxed bg-blue/5 border border-blue/15 rounded-xl px-4 py-3">
                {eodData.verdict}
              </p>
              {/* Index Futures net positions — the most important segment */}
              {(() => {
                const seg = eodData.segments.find(s => s.name === "Index Futures");
                if (!seg) return null;
                return (
                  <div>
                    <p className="text-xs font-semibold text-dark/50 mb-2 uppercase tracking-wide">
                      Index Futures — Net Position Today (Long − Short)
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {seg.rows.map(row => {
                        const c = PARTICIPANT_COLOR[row.participant] || PARTICIPANT_COLOR["Clients"];
                        const isPos = row.netToday >= 0;
                        return (
                          <div key={row.participant} className={`rounded-xl border p-3 ${c.bg} ${c.border}`}>
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                              <span className={`text-xs font-bold ${c.text}`}>{row.participant}</span>
                            </div>
                            <div className={`text-base font-mono font-bold ${isPos ? "text-emerald-700" : "text-red-600"}`}>
                              {fmt(row.netToday)}
                            </div>
                            <div className={`text-xs mt-0.5 ${row.netChange >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                              {row.netChange >= 0 ? "▲" : "▼"} {fmt(Math.abs(row.netChange))} today
                            </div>
                            <div className={`text-xs mt-1 font-medium ${
                              row.sentiment === "bullish" ? "text-emerald-700"
                              : row.sentiment === "bearish" ? "text-red-600"
                              : "text-amber-600"
                            }`}>
                              {row.sentiment === "bullish" ? "↑ Bullish" : row.sentiment === "bearish" ? "↓ Bearish" : "→ Neutral"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-dark/40 mt-2">
                      + = net long (holding more buys than sells) · − = net short (holding more sells than buys)
                    </p>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* ── DeepSeek Analysis ──────────────────────────────────────────────── */}
      {loadingAnalysis ? (
        <div className="bg-white border border-blue/15 rounded-2xl p-10 text-center">
          <Brain size={28} className="text-violet-300 mx-auto mb-3 animate-pulse" />
          <p className="text-sm text-dark/40">Loading analysis…</p>
        </div>
      ) : !latest ? (
        <div className="bg-gradient-to-br from-violet-50 to-purple-50 border border-violet-200 rounded-2xl p-8 text-center space-y-3">
          <Brain size={32} className="text-violet-300 mx-auto" />
          <p className="text-base font-bold text-violet-800">No Analysis Yet</p>
          <p className="text-sm text-violet-600 max-w-md mx-auto leading-relaxed">
            DeepSeek auto-runs every evening at <strong>3:45 PM IST</strong>. It reads the
            3-min strike timeline for ATM ±500 strikes, crosses it with EOD participant data,
            and figures out exactly where FIIs and PropDesk are positioned.
          </p>
          <p className="text-xs text-violet-500 max-w-sm mx-auto">
            Today's participant data is loaded. Click <strong>"Run Analysis Now"</strong> to
            trigger DeepSeek immediately — it takes about 60–90 seconds.
          </p>
        </div>
      ) : (
        <div className="space-y-4">

          {/* ── Signal header ─────────────────────────────────────────────── */}
          <div className="bg-white border border-blue/15 rounded-2xl p-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <BiasBadge bias={latest.bias} confidence={latest.confidence} />
              <div className="flex items-center gap-2 text-xs text-dark/40">
                <Clock size={12} />
                Analysis for <strong className="text-dark/60">{latest.date}</strong>
                &nbsp;·&nbsp;
                {new Date(latest.generatedAt).toLocaleTimeString("en-IN", {
                  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit",
                })} IST
              </div>
            </div>
            {/* Key levels */}
            {(latest.keyLevels?.support?.length > 0 || latest.keyLevels?.resistance?.length > 0) && (
              <div className="flex flex-wrap gap-3 text-xs">
                {latest.keyLevels.support.map(l => (
                  <span key={l} className="px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full font-mono font-semibold">
                    🛡 Support: {l.toLocaleString("en-IN")}
                  </span>
                ))}
                {latest.keyLevels.resistance.map(l => (
                  <span key={l} className="px-3 py-1 bg-red-50 border border-red-200 text-red-700 rounded-full font-mono font-semibold">
                    🚧 Resistance: {l.toLocaleString("en-IN")}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Three story cards ──────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

            {/* Card 1: What smart money did last 5 days */}
            <div className="bg-white border border-blue/15 rounded-2xl p-5 space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="bg-violet-100 p-1.5 rounded-lg">
                  <Eye size={13} className="text-violet-600" />
                </div>
                <p className="text-xs font-bold text-dark uppercase tracking-wide">What Smart Money Did</p>
              </div>
              <p className="text-xs text-dark/40 italic">Last 5 days story</p>
              <p className="text-sm text-dark/80 leading-relaxed">{latest.narrative || "—"}</p>
            </div>

            {/* Card 2: Trap Alert */}
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5 space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="bg-amber-100 p-1.5 rounded-lg">
                  <AlertTriangle size={13} className="text-amber-600" />
                </div>
                <p className="text-xs font-bold text-amber-800 uppercase tracking-wide">Trap Alert</p>
              </div>
              <p className="text-xs text-amber-600 italic">What trap is set for tomorrow?</p>
              <p className="text-sm text-amber-900 leading-relaxed">{latest.trapAlert || "No clear trap identified today."}</p>
            </div>

            {/* Card 3: Tomorrow's Plan */}
            <div className="bg-gradient-to-br from-blue/5 to-blue/10 border border-blue/20 rounded-2xl p-5 space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="bg-blue/15 p-1.5 rounded-lg">
                  <Target size={13} className="text-blue" />
                </div>
                <p className="text-xs font-bold text-dark uppercase tracking-wide">Tomorrow's Plan</p>
              </div>
              <p className="text-xs text-dark/40 italic">Concrete levels &amp; action</p>
              <p className="text-sm text-dark/80 leading-relaxed">{latest.nextDayPlan || "—"}</p>
            </div>
          </div>

          {/* ── DeepSeek reasoning (hidden by default) ────────────────────── */}
          {latest.reasoning && (
            <div className="bg-violet-50 border border-violet-200 rounded-2xl overflow-hidden">
              <button
                onClick={() => setShowReasoning(v => !v)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-violet-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Brain size={14} className="text-violet-500" />
                  <span className="text-sm font-bold text-violet-800">View DeepSeek R1 Reasoning</span>
                  <span className="text-xs text-violet-400 bg-violet-200 px-2 py-0.5 rounded-full">
                    How it reached this conclusion
                  </span>
                </div>
                {showReasoning ? <ChevronUp size={15} className="text-violet-400" /> : <ChevronDown size={15} className="text-violet-400" />}
              </button>
              {showReasoning && (
                <div className="px-5 pb-5 border-t border-violet-200">
                  <pre className="text-xs text-violet-900/60 leading-relaxed whitespace-pre-wrap font-mono mt-4 max-h-96 overflow-y-auto">
                    {latest.reasoning}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── EOD ATM ±400 Strike Summary ─────────────────────────────────────── */}
      <div className="bg-white border border-blue/15 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-blue/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue/10 p-1.5 rounded-lg">
              <Eye size={14} className="text-blue" />
            </div>
            <div>
              <p className="text-sm font-bold text-dark">ATM ±400 Strike Summary</p>
              <p className="text-xs text-dark/40">
                What happened today at each key strike · Cross-referenced with participant data · 100pt intervals only
              </p>
            </div>
          </div>
          <button
            onClick={triggerStrikeSummary}
            disabled={triggeringSummary}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue/8 hover:bg-blue/15 text-blue border border-blue/15 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            {triggeringSummary
              ? <><RefreshCw size={11} className="animate-spin" /> Generating…</>
              : <><RefreshCw size={11} /> Generate</>}
          </button>
        </div>

        {strikeSummary ? (
          <div className="p-5 space-y-4">
            {/* Overall narrative */}
            <div className="rounded-xl bg-blue/4 border border-blue/10 px-4 py-3">
              <p className="text-xs font-bold text-blue uppercase tracking-wide mb-1">Overall Market Narrative</p>
              <p className="text-sm text-dark/80 leading-relaxed">{strikeSummary.overallNarrative}</p>
              <p className="text-[10px] text-dark/30 mt-2">
                Nifty Spot ≈ {strikeSummary.niftySpot?.toLocaleString("en-IN")} · ATM = {strikeSummary.atm?.toLocaleString("en-IN")} · {strikeSummary.date}
              </p>
            </div>

            {/* Per-strike table */}
            <div className="overflow-x-auto rounded-xl border border-blue/10">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-dark/8 bg-dark/2">
                    <th className="text-left py-2.5 px-4 text-dark/50 font-semibold">Strike</th>
                    <th className="text-left py-2.5 px-3 text-dark/50 font-semibold">CE Activity</th>
                    <th className="text-left py-2.5 px-3 text-dark/50 font-semibold">PE Activity</th>
                    <th className="text-left py-2.5 px-3 text-dark/50 font-semibold">Likely Who</th>
                    <th className="text-left py-2.5 px-3 text-dark/50 font-semibold">What Happened</th>
                    <th className="text-center py-2.5 px-3 text-dark/50 font-semibold">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {strikeSummary.strikes?.map((s, i) => {
                    const sigColor = s.significance === "HIGH"
                      ? "bg-red-100 text-red-700 border-red-200"
                      : s.significance === "MEDIUM"
                      ? "bg-amber-100 text-amber-700 border-amber-200"
                      : "bg-gray-100 text-gray-500 border-gray-200";
                    const isAtm = s.label === "ATM";
                    return (
                      <tr key={i} className={`border-b border-dark/5 hover:bg-dark/2 transition-colors ${isAtm ? "bg-blue/3" : ""}`}>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-dark">{s.strike?.toLocaleString("en-IN")}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${isAtm ? "bg-blue/15 text-blue border-blue/20" : "bg-dark/5 text-dark/40 border-dark/10"}`}>
                              {s.label}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-dark/70">{s.callActivity || "—"}</td>
                        <td className="py-3 px-3 text-dark/70">{s.putActivity || "—"}</td>
                        <td className="py-3 px-3">
                          {s.likelyParticipant && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${
                              PARTICIPANT_COLOR[s.likelyParticipant]?.bg || "bg-gray-50"
                            } ${PARTICIPANT_COLOR[s.likelyParticipant]?.border || "border-gray-200"} ${PARTICIPANT_COLOR[s.likelyParticipant]?.text || "text-gray-700"}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${PARTICIPANT_COLOR[s.likelyParticipant]?.dot || "bg-gray-400"}`} />
                              {s.likelyParticipant}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-dark/70 max-w-xs">{s.whatHappened}</td>
                        <td className="py-3 px-3 text-center">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${sigColor}`}>
                            {s.significance}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center">
            <Eye size={24} className="text-dark/20 mx-auto mb-2" />
            <p className="text-sm text-dark/40">No strike summary yet.</p>
            <p className="text-xs text-dark/30 mt-1">
              Auto-generates at 3:45 PM IST after EOD analysis. Or click <strong>Generate</strong> above.
            </p>
          </div>
        )}
      </div>

      {/* ── Strike Watchlist (7-day tracking) ──────────────────────────────── */}
      <div className="bg-white border border-blue/15 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-blue/10 bg-blue/3">
          <div className="flex items-center gap-2">
            <div className="bg-blue/10 p-1.5 rounded-lg">
              <Shield size={14} className="text-blue" />
            </div>
            <div>
              <p className="text-sm font-bold text-dark">Monitored Strikes</p>
              <p className="text-xs text-dark/40">
                ATM/ITM strikes (within ±300) where FIIs / PropDesk are likely active · Tracked for 7 days
              </p>
            </div>
          </div>
        </div>

        {watchlistEntries.length === 0 ? (
          <div className="p-8 text-center">
            <Target size={24} className="text-dark/20 mx-auto mb-2" />
            <p className="text-sm text-dark/40">No active strikes yet.</p>
            <p className="text-xs text-dark/30 mt-1">Strikes will appear here after the first analysis.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-dark/8 bg-dark/2">
                  <th className="text-left py-3 px-4 text-dark/50 font-semibold">Strike</th>
                  <th className="text-left py-3 px-3 text-dark/50 font-semibold">Who</th>
                  <th className="text-left py-3 px-3 text-dark/50 font-semibold">What they're doing</th>
                  <th className="text-left py-3 px-3 text-dark/50 font-semibold">What it means</th>
                  <th className="text-center py-3 px-3 text-dark/50 font-semibold">Confidence</th>
                  <th className="text-left py-3 px-3 text-dark/50 font-semibold">Premium track (7 days)</th>
                  <th className="text-left py-3 px-3 text-dark/50 font-semibold">Predicted on</th>
                </tr>
              </thead>
              <tbody>
                {watchlistEntries.map((w, i) => {
                  const pColor  = PARTICIPANT_COLOR[w.participant] || PARTICIPANT_COLOR["Clients"];
                  const actCls  = ACTIVITY_COLOR[w.activity] || "text-dark/60 bg-dark/5 border-dark/10";
                  const isActive = w.status === "ACTIVE";
                  return (
                    <tr
                      key={`${w.analysisDate}-${w.strike}-${w.type}-${i}`}
                      className={`border-b border-dark/5 hover:bg-dark/2 transition-colors ${!isActive ? "opacity-50" : ""}`}
                    >
                      {/* Strike + CE/PE */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-dark text-sm">
                            {w.strike.toLocaleString("en-IN")}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded font-bold text-xs ${
                            w.type === "CE"
                              ? "bg-red-100 text-red-700"
                              : "bg-emerald-100 text-emerald-700"
                          }`}>
                            {w.type}
                          </span>
                          <span className="text-dark/30 text-xs">{w.index}</span>
                        </div>
                        {!isActive && (
                          <span className="text-dark/30 text-xs">Expired</span>
                        )}
                      </td>

                      {/* Who */}
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${pColor.bg} ${pColor.border} ${pColor.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${pColor.dot}`} />
                          {w.participant}
                        </span>
                      </td>

                      {/* Activity */}
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border ${actCls}`}>
                          {w.activity.includes("Writing") ? <TrendingDown size={10} /> : <TrendingUp size={10} />}
                          {w.activity}
                        </span>
                      </td>

                      {/* Simple explanation */}
                      <td className="py-3 px-3 max-w-48">
                        <p className="text-dark/65 leading-relaxed">{w.simpleExplanation}</p>
                      </td>

                      {/* Confidence */}
                      <td className="py-3 px-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                          w.confidence === "HIGH"   ? "bg-emerald-100 text-emerald-700" :
                          w.confidence === "MEDIUM" ? "bg-amber-100 text-amber-700" :
                                                      "bg-slate-100 text-slate-500"
                        }`}>
                          {w.confidence}
                        </span>
                      </td>

                      {/* Premium history sparkline */}
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          <span className="text-dark/40 font-mono">₹{w.entryPremium.toFixed(1)}</span>
                          <span className="text-dark/20">→</span>
                          <PremiumSparkline history={w.premiumHistory} />
                        </div>
                      </td>

                      {/* Date */}
                      <td className="py-3 px-3 text-dark/40 font-mono">{w.predictedDate}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-4 py-3 border-t border-dark/5 bg-dark/1">
              <p className="text-xs text-dark/35">
                <strong>How to read the premium track:</strong> Green bar = premium fell (writing positions are working).
                Red bar = premium rose (position under pressure). Last bar has a ring = today's price.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── 7-day history strip ─────────────────────────────────────────────── */}
      {analysis?.history && analysis.history.length > 1 && (
        <div className="bg-white border border-blue/15 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Zap size={14} className="text-blue" />
            <p className="text-sm font-bold text-dark">Learning History — Last 7 Days</p>
            <p className="text-xs text-dark/40">Each day's bias · DeepSeek learns from this</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...analysis.history].reverse().map(m => (
              <div
                key={m.date}
                className={`flex flex-col items-center px-3 py-2 rounded-xl border text-xs font-medium ${
                  m.bias === "BULLISH" ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
                  m.bias === "BEARISH" ? "bg-red-50 border-red-200 text-red-700" :
                                         "bg-amber-50 border-amber-200 text-amber-700"
                }`}
              >
                <span className="font-mono text-dark/50">{m.date}</span>
                <span className="font-bold mt-0.5">{m.bias}</span>
                <span className="opacity-70">{m.confidence}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
