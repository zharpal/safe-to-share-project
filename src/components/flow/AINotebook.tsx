import { BookOpen, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Clock, RefreshCw } from "lucide-react";

interface NotebookEntry {
  date: string;
  generatedAt: string;
  regime: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "SPLIT";
  confidence: number;
  headline: string;
  paragraphs: string[];
  recentChangeSummary: string;
  caveats: string[];
  keyLevels: { support: number[]; resistance: number[] };
}

interface AINotebookProps {
  notebook: NotebookEntry | null;
  loading: boolean;
}

// Render markdown-lite: **bold** and bullet-like text
function RenderParagraph({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p className="text-sm text-slate-700 leading-relaxed">
      {parts.map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold text-slate-900">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

export function AINotebook({ notebook, loading }: AINotebookProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen size={16} className="text-violet-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">AI Notebook</span>
        </div>
        <div className="animate-pulse space-y-2">
          {[1,2,3].map(i => <div key={i} className="h-4 bg-slate-100 rounded" style={{ width: `${75 + i * 7}%` }} />)}
        </div>
      </div>
    );
  }

  if (!notebook) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <BookOpen size={16} className="text-violet-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">AI Notebook</span>
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <RefreshCw size={14} className="animate-spin" />
          <span>Commentary generating — needs at least one capture cycle…</span>
        </div>
      </div>
    );
  }

  const updatedAgo = Math.round((Date.now() - new Date(notebook.generatedAt).getTime()) / 60000);

  const biasMeta = {
    BULLISH: { cls: "bg-emerald-50 border-emerald-200 text-emerald-700", icon: <TrendingUp size={13} />, label: "Bullish" },
    BEARISH: { cls: "bg-rose-50 border-rose-200 text-rose-700",         icon: <TrendingDown size={13} />, label: "Bearish" },
    NEUTRAL: { cls: "bg-slate-50 border-slate-200 text-slate-600",      icon: <Minus size={13} />, label: "Neutral" },
    SPLIT:   { cls: "bg-amber-50 border-amber-200 text-amber-700",      icon: <Minus size={13} />, label: "Split" },
  }[notebook.bias];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-violet-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">AI Notebook</span>
          <span className="text-[10px] text-slate-400 italic">rule-based</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <Clock size={10} />
          <span>{updatedAgo < 2 ? "just now" : `${updatedAgo}m ago`}</span>
        </div>
      </div>

      {/* Headline + bias */}
      <div className={`flex items-start gap-2 p-3 rounded-xl border mb-4 ${biasMeta.cls}`}>
        <div className="shrink-0 mt-0.5">{biasMeta.icon}</div>
        <div>
          <p className="text-xs font-semibold leading-snug">{notebook.headline}</p>
          <p className="text-[10px] mt-0.5 opacity-70">{biasMeta.label} · {notebook.confidence}% confidence</p>
        </div>
      </div>

      {/* Recent change summary */}
      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-50 border border-blue-100 mb-4">
        <Clock size={11} className="text-blue-500 mt-0.5 shrink-0" />
        <p className="text-xs text-blue-700">{notebook.recentChangeSummary}</p>
      </div>

      {/* Paragraphs */}
      <div className="space-y-3 mb-4">
        {notebook.paragraphs.slice(0, 4).map((p, i) => (
          <RenderParagraph key={i} text={p} />
        ))}
      </div>

      {/* Key levels */}
      {(notebook.keyLevels.resistance.length > 0 || notebook.keyLevels.support.length > 0) && (
        <div className="flex gap-3 mb-4">
          {notebook.keyLevels.resistance.length > 0 && (
            <div className="flex-1 p-2.5 rounded-lg bg-rose-50 border border-rose-100">
              <p className="text-[10px] font-bold text-rose-600 mb-1 uppercase tracking-wide">Resistance</p>
              <div className="flex flex-wrap gap-1">
                {notebook.keyLevels.resistance.map(l => (
                  <span key={l} className="text-xs font-bold text-rose-700 tabular-nums">
                    {l.toLocaleString("en-IN")}
                  </span>
                ))}
              </div>
            </div>
          )}
          {notebook.keyLevels.support.length > 0 && (
            <div className="flex-1 p-2.5 rounded-lg bg-emerald-50 border border-emerald-100">
              <p className="text-[10px] font-bold text-emerald-600 mb-1 uppercase tracking-wide">Support</p>
              <div className="flex flex-wrap gap-1">
                {notebook.keyLevels.support.map(l => (
                  <span key={l} className="text-xs font-bold text-emerald-700 tabular-nums">
                    {l.toLocaleString("en-IN")}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Caveats */}
      {notebook.caveats.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-100">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={11} className="text-amber-600" />
            <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Watch Out</p>
          </div>
          <ul className="space-y-1">
            {notebook.caveats.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                <span className="shrink-0 mt-1 w-1 h-1 rounded-full bg-amber-500" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
