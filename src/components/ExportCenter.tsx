import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, CheckCircle, AlertCircle, Archive,
  FileSpreadsheet, PackageCheck, Loader2, RotateCcw, FolderOpen,
  CalendarDays,
} from "lucide-react";

const GDRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/1Ox-KwlzyQhQyRwPrnv_if5pmNrDs6vSf";

type ExportResponse = {
  ok: boolean;
  date: string;
  openingSpot: number | null;
  strikeCount: number;
  writtenCount: number;
  uploadedCount?: number;
  reason?: string;
  files?: string[];
};

type Step = {
  id: string;
  label: string;
  done: boolean;
  active: boolean;
};

// ── IST helpers ───────────────────────────────────────────────────────────────
function getISTDateLabel() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const day   = parts.find(p => p.type === "day")?.value   || "";
  const month = parts.find(p => p.type === "month")?.value || "";
  const year  = parts.find(p => p.type === "year")?.value  || "";
  return `${year}-${month}-${day}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ExportCenter() {
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<ExportResponse | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [stepIdx, setStepIdx]   = useState(-1);
  const [dateLabel, setDateLabel] = useState(getISTDateLabel);
  // User-selected export date (YYYY-MM-DD, IST). Defaults to today but the user
  // can pick any past date for which data exists.
  const [selectedDate, setSelectedDate] = useState(getISTDateLabel);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refresh date label every minute and keep the picker's max bound in sync.
  useEffect(() => {
    timerRef.current = setInterval(() => setDateLabel(getISTDateLabel()), 60000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Load last export metadata on mount
  useEffect(() => {
    fetch("/api/manual-export/last")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setResult(d); })
      .catch(() => {});
  }, []);

  const STEPS: Step[] = useMemo(() => [
    { id: "init",    label: "Resolving opening spot price",       done: stepIdx > 0, active: stepIdx === 0 },
    { id: "strikes", label: "Building ATM ±500 strike workbooks", done: stepIdx > 1, active: stepIdx === 1 },
    { id: "eod",     label: "Exporting EOD participant data",     done: stepIdx > 2, active: stepIdx === 2 },
    { id: "zip",     label: "Creating ZIP archive",               done: stepIdx > 3, active: stepIdx === 3 },
    { id: "done",    label: "Download ready",                     done: stepIdx > 4, active: stepIdx === 4 },
  ], [stepIdx]);

  const handleExport = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setStepIdx(0);

    // Simulate step progress while the request is in-flight
    const advance = (delay: number, idx: number) =>
      new Promise<void>(res => setTimeout(() => { setStepIdx(idx); res(); }, delay));

    try {
      // Step simulation (visual only — real work is server-side)
      const advancePromise = (async () => {
        await advance(400,  1);
        await advance(1800, 2);
        await advance(2400, 3);
      })();

      const res = await fetch("/api/manual-export/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: selectedDate }),
      });

      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data = await res.json();
            if (data?.error) msg = data.error;
          }
        } catch {}
        throw new Error(msg);
      }

      await advancePromise;
      setStepIdx(4); // ZIP step

      const dateHeader = res.headers.get("x-export-date") || selectedDate;
      const blob = await res.blob();

      setStepIdx(5); // Done

      // Trigger browser download
      const url = window.URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href     = url;
      a.download = `${dateHeader}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      // Fetch updated metadata
      try {
        const metaRes = await fetch("/api/manual-export/last");
        if (metaRes.ok) {
          setResult(await metaRes.json());
        } else {
          setResult({ ok: true, date: dateHeader, openingSpot: null, strikeCount: 21, writtenCount: 0 });
        }
      } catch {
        setResult({ ok: true, date: dateHeader, openingSpot: null, strikeCount: 21, writtenCount: 0 });
      }
    } catch (e: any) {
      setError(e.message || "Export failed");
      setStepIdx(-1);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  return (
    <div className="p-6 space-y-5 tab-panel-enter">
      {/* Header card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="bg-white/70 border border-blue/15 rounded-2xl shadow-sm overflow-hidden"
      >
        <div className="px-6 py-5 border-b border-blue/10 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-dark">Export Center</h2>
            <p className="text-xs text-blue font-semibold mt-0.5 tracking-widest uppercase">
              ATM ±500 · Strike workbooks + Participant data
            </p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* What the export creates */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { icon: FileSpreadsheet, label: "Per-strike XLSX",   sub: "21 files (ATM ±500 in 50pt steps)" },
              { icon: Archive,         label: "Participant CSV",    sub: "EOD FII / DII / PRO / Client OI"  },
              { icon: PackageCheck,    label: "ZIP archive",        sub: "Single download, date-stamped"    },
            ].map(({ icon: Icon, label, sub }, i) => (
              <div key={label} className={`card-animate card-animate-d${i + 1} flex items-start gap-3 rounded-xl border border-blue/10 bg-bg/60 px-4 py-3`}>
                <div className="mt-0.5 p-1.5 rounded-lg bg-blue/10">
                  <Icon size={15} className="text-blue" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-dark">{label}</p>
                  <p className="text-xs text-dark/55 mt-0.5">{sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Action row: date picker + export button + drive link */}
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="export-date"
              className="flex items-center gap-2 px-3 py-3 rounded-xl border border-blue/20 bg-white shadow-sm"
            >
              <CalendarDays size={15} className="text-blue" />
              <span className="text-xs font-semibold text-dark/70 uppercase tracking-wider">Export date</span>
              <input
                id="export-date"
                type="date"
                value={selectedDate}
                max={dateLabel}
                onChange={(e) => setSelectedDate(e.target.value)}
                disabled={loading}
                className="bg-transparent text-sm font-semibold text-dark outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <button
              onClick={handleExport}
              disabled={loading || !selectedDate}
              className="flex items-center gap-2.5 px-6 py-3 rounded-xl bg-blue text-white font-bold text-sm shadow-md
                         hover:bg-dark transition-all duration-150 active:scale-[0.98]
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {loading
                ? <Loader2 size={16} className="animate-spin" />
                : <Download size={16} />}
              {loading
                ? "Preparing export…"
                : selectedDate === dateLabel
                  ? "Export Today's ATM ±500 Data"
                  : `Export ${selectedDate} Data`}
            </button>

            <a
              href={GDRIVE_FOLDER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-3 rounded-xl border border-blue/20 bg-white text-blue font-semibold text-sm
                         hover:bg-blue/5 hover:border-blue/40 transition-all duration-150 active:scale-[0.98] shadow-sm"
            >
              <FolderOpen size={15} />
              Open Drive Folder
            </a>
          </div>

          {/* Step-by-step progress */}
          <AnimatePresence>
            {loading && (
              <motion.div
                key="steps"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden"
              >
                <div className="rounded-xl border border-blue/10 bg-bg/50 px-4 py-3 space-y-2.5">
                  {STEPS.map(step => (
                    <div key={step.id} className="flex items-center gap-2.5 text-xs">
                      <span className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300 ${
                        step.done
                          ? "bg-emerald-500 text-white"
                          : step.active
                          ? "border-2 border-blue bg-white"
                          : "border border-dark/20 bg-white"
                      }`}>
                        {step.done
                          ? <CheckCircle size={10} />
                          : step.active
                          ? <Loader2 size={9} className="animate-spin text-blue" />
                          : null}
                      </span>
                      <span className={step.done ? "text-emerald-700 line-through" : step.active ? "text-blue font-medium" : "text-dark/40"}>
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Result / Error */}
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3"
              >
                <AlertCircle size={15} className="mt-0.5 text-rose-500 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-rose-700">Export failed</p>
                  <p className="text-xs text-rose-600">{error}</p>
                  <button
                    onClick={() => { setError(null); setStepIdx(-1); }}
                    className="flex items-center gap-1 text-xs text-rose-500 hover:text-rose-700 mt-1"
                  >
                    <RotateCcw size={11} /> Dismiss
                  </button>
                </div>
              </motion.div>
            )}

            {!error && result && (
              <motion.div
                key={result.ok ? "success" : "warn"}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className={`rounded-xl border px-4 py-3 ${
                  result.ok
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className={`flex items-center gap-2 font-semibold text-sm ${result.ok ? "text-emerald-700" : "text-amber-800"}`}>
                  {result.ok ? <CheckCircle size={15} /> : <Archive size={15} />}
                  {result.ok ? "Export downloaded successfully" : "Export not created"}
                </div>

                {result.ok ? (
                  <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-emerald-800/80">
                    <span className="text-emerald-600 font-medium">Date</span>
                    <span>{result.date}</span>
                    <span className="text-emerald-600 font-medium">Opening spot</span>
                    <span>{result.openingSpot != null ? result.openingSpot.toLocaleString("en-IN") : "—"}</span>
                    <span className="text-emerald-600 font-medium">Strike range</span>
                    <span>{result.strikeCount} strikes</span>
                    <span className="text-emerald-600 font-medium">Files in ZIP</span>
                    <span>{result.writtenCount}</span>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-amber-700">{result.reason || "Unknown reason"}</p>
                )}

                {result.files && result.files.length > 0 && (
                  <details className="mt-2.5">
                    <summary className="text-xs text-emerald-600 cursor-pointer hover:text-emerald-800 select-none">
                      View file list ({result.files.length})
                    </summary>
                    <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                      {result.files.map(f => (
                        <li key={f} className="text-[11px] text-emerald-700 font-mono">{f}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Info card */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        className="bg-white/60 border border-blue/10 rounded-2xl px-6 py-4"
      >
        <p className="text-xs font-bold text-blue uppercase tracking-widest mb-2.5">How it works</p>
        <ol className="space-y-1.5 text-sm text-dark/70 list-decimal list-inside">
          <li>Pick the date you want from the <strong className="text-dark">Export date</strong> field — it defaults to today, but you can export any past trading day for which data was captured.</li>
          <li>Click <strong className="text-dark">Export</strong> to start.</li>
          <li>The server calculates the opening Nifty spot for the chosen date to determine the ATM strike.</li>
          <li>It creates one XLSX workbook per strike (ATM ±500, 21 strikes total) with COI, IV, LTP columns and unusual-activity highlights.</li>
          <li>EOD participant data (FII/DII/PRO/Client) is exported as CSV + XLSX.</li>
          <li>All files are zipped into a single <code className="bg-black/5 rounded px-1 text-dark">{selectedDate}.zip</code> and downloaded automatically.</li>
          <li>Use <strong className="text-dark">Open Drive Folder</strong> to upload the ZIP to Google Drive manually.</li>
        </ol>
      </motion.div>
    </div>
  );
}
