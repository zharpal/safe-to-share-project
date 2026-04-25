import { useEffect, useRef, useState } from "react";
import { Activity, ArrowDownUp, TrendingUp, TrendingDown, Zap, Shield, Layers, Wind, BarChart2, Flame, Pin } from "lucide-react";

// ── Inline types ────────────────────────────────────────────────────────────

type FlowEventType =
  | "FRESH_WRITING"
  | "SHORT_COVERING"
  | "LONG_BUILDUP"
  | "LONG_UNWINDING"
  | "CHURN"
  | "WALL_CREATION"
  | "WALL_MIGRATION"
  | "LIQUIDITY_SWEEP"
  | "ABSORPTION"
  | "IV_SHOCK"
  | "EXPIRY_PIN";

type EventSide = "CALL" | "PUT" | "BOTH";
type EventSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface FlowEvent {
  id: string;
  date: string;
  timestamp: string;
  strike: number;
  type: FlowEventType;
  side: EventSide;
  confidence: number;
  severity: EventSeverity;
  explanation: string;
  features: Record<string, any>;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface EventTapeProps {
  events: FlowEvent[];
  loading: boolean;
}

// ── Filter config ────────────────────────────────────────────────────────────

type FilterTab = "ALL" | "Writing" | "Buildup" | "Sweep/Trap" | "IV" | "Unwind";

const FILTER_MAP: Record<FilterTab, FlowEventType[]> = {
  ALL: [],
  Writing: ["FRESH_WRITING", "WALL_CREATION", "WALL_MIGRATION"],
  Buildup: ["LONG_BUILDUP", "SHORT_COVERING", "ABSORPTION"],
  "Sweep/Trap": ["LIQUIDITY_SWEEP", "CHURN"],
  IV: ["IV_SHOCK"],
  Unwind: ["LONG_UNWINDING", "EXPIRY_PIN"],
};

const FILTER_TABS: FilterTab[] = ["ALL", "Writing", "Buildup", "Sweep/Trap", "IV", "Unwind"];

// ── Color / icon maps ────────────────────────────────────────────────────────

interface TypeStyle {
  bg: string;
  text: string;
  border: string;
  bar: string;
  label: string;
  Icon: (props: { size?: number; className?: string }) => JSX.Element;
}

const TYPE_STYLES: Record<FlowEventType, TypeStyle> = {
  FRESH_WRITING: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    bar: "bg-blue-500",
    label: "Writing",
    Icon: ({ size = 12, className = "" }) => <Activity size={size} className={className} />,
  },
  LONG_BUILDUP: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    bar: "bg-emerald-500",
    label: "Buildup",
    Icon: ({ size = 12, className = "" }) => <TrendingUp size={size} className={className} />,
  },
  SHORT_COVERING: {
    bg: "bg-teal-500/10",
    text: "text-teal-400",
    border: "border-teal-500/30",
    bar: "bg-teal-500",
    label: "Short Cover",
    Icon: ({ size = 12, className = "" }) => <ArrowDownUp size={size} className={className} />,
  },
  LONG_UNWINDING: {
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    border: "border-orange-500/30",
    bar: "bg-orange-500",
    label: "Unwind",
    Icon: ({ size = 12, className = "" }) => <TrendingDown size={size} className={className} />,
  },
  CHURN: {
    bg: "bg-slate-500/10",
    text: "text-slate-400",
    border: "border-slate-500/30",
    bar: "bg-slate-500",
    label: "Churn",
    Icon: ({ size = 12, className = "" }) => <Wind size={size} className={className} />,
  },
  WALL_CREATION: {
    bg: "bg-violet-500/10",
    text: "text-violet-400",
    border: "border-violet-500/30",
    bar: "bg-violet-500",
    label: "Wall",
    Icon: ({ size = 12, className = "" }) => <Shield size={size} className={className} />,
  },
  WALL_MIGRATION: {
    bg: "bg-indigo-500/10",
    text: "text-indigo-400",
    border: "border-indigo-500/30",
    bar: "bg-indigo-500",
    label: "Wall Move",
    Icon: ({ size = 12, className = "" }) => <Layers size={size} className={className} />,
  },
  LIQUIDITY_SWEEP: {
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/30",
    bar: "bg-rose-500",
    label: "Sweep",
    Icon: ({ size = 12, className = "" }) => <Zap size={size} className={className} />,
  },
  ABSORPTION: {
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/30",
    bar: "bg-amber-500",
    label: "Absorption",
    Icon: ({ size = 12, className = "" }) => <BarChart2 size={size} className={className} />,
  },
  IV_SHOCK: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    border: "border-red-500/30",
    bar: "bg-red-500",
    label: "IV Shock",
    Icon: ({ size = 12, className = "" }) => <Flame size={size} className={className} />,
  },
  EXPIRY_PIN: {
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    border: "border-purple-500/30",
    bar: "bg-purple-500",
    label: "Expiry Pin",
    Icon: ({ size = 12, className = "" }) => <Pin size={size} className={className} />,
  },
};

const SEVERITY_DOT: Record<EventSeverity, string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-amber-400",
  LOW: "bg-slate-500",
};

const SIDE_LABEL: Record<EventSide, { label: string; cls: string }> = {
  CALL: { label: "CE", cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
  PUT: { label: "PE", cls: "text-rose-400 bg-rose-500/10 border-rose-500/30" },
  BOTH: { label: "Both", cls: "text-slate-300 bg-slate-500/10 border-slate-500/30" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "--:--";
  }
}

// ── Skeleton row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-white/5 animate-pulse">
      <div className="w-2 h-2 rounded-full bg-white/10 shrink-0" />
      <div className="w-10 h-3 rounded bg-white/10 shrink-0" />
      <div className="w-14 h-3 rounded bg-white/10 shrink-0" />
      <div className="w-20 h-5 rounded bg-white/10 shrink-0" />
      <div className="w-10 h-5 rounded bg-white/10 shrink-0" />
      <div className="flex-1 h-3 rounded bg-white/10" />
    </div>
  );
}

// ── Event row ────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: FlowEvent }) {
  const [expanded, setExpanded] = useState(false);
  const style = TYPE_STYLES[event.type];
  const { Icon } = style;
  const sideStyle = SIDE_LABEL[event.side];

  return (
    <div
      className="border-b border-white/5 hover:bg-white/[0.03] transition-colors cursor-pointer"
      onClick={() => setExpanded((p) => !p)}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5 min-w-0">
        {/* Severity dot */}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${SEVERITY_DOT[event.severity]}`}
          title={event.severity}
        />

        {/* Time */}
        <span className="text-[11px] text-slate-500 tabular-nums w-10 shrink-0">
          {formatTime(event.timestamp)}
        </span>

        {/* Strike */}
        <span className="text-[13px] font-bold text-dark w-14 shrink-0 tabular-nums">
          {event.strike.toLocaleString("en-IN")}
        </span>

        {/* Type badge */}
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${style.bg} ${style.text} ${style.border}`}
        >
          <Icon size={10} />
          {style.label}
        </span>

        {/* Side badge */}
        <span
          className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${sideStyle.cls}`}
        >
          {sideStyle.label}
        </span>

        {/* Confidence bar */}
        <div className="flex items-center gap-1.5 shrink-0 w-16">
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full rounded-full ${style.bar} transition-all`}
              style={{ width: `${Math.min(100, Math.max(0, event.confidence))}%` }}
            />
          </div>
          <span className="text-[10px] text-slate-500 tabular-nums w-6 text-right">
            {Math.round(event.confidence)}
          </span>
        </div>

        {/* Explanation (truncated) */}
        <p className="text-[11px] text-slate-400 truncate flex-1 min-w-0">
          {event.explanation}
        </p>
      </div>

      {/* Expanded explanation */}
      {expanded && (
        <div className="px-3 pb-2.5 pt-0">
          <p className="text-[12px] text-slate-300 leading-relaxed pl-[calc(0.5rem+2.5rem+3.5rem+5rem+2.5rem+4rem+0.625rem)]">
            {event.explanation}
          </p>
          {Object.keys(event.features).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[calc(0.5rem+2.5rem+3.5rem+5rem+2.5rem+4rem+0.625rem)]">
              {Object.entries(event.features)
                .slice(0, 6)
                .map(([k, v]) => (
                  <span
                    key={k}
                    className="text-[10px] text-slate-500 bg-white/5 border border-white/10 rounded px-1.5 py-0.5"
                  >
                    {k}: <span className="text-slate-400">{String(v)}</span>
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function EventTape({ events, loading }: EventTapeProps) {
  const [activeTab, setActiveTab] = useState<FilterTab>("ALL");
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(events.length);

  // Auto-scroll to top when new events arrive
  useEffect(() => {
    if (events.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    prevCountRef.current = events.length;
  }, [events.length]);

  const filtered =
    activeTab === "ALL"
      ? events
      : events.filter((e) => FILTER_MAP[activeTab].includes(e.type));

  return (
    <div className="flex flex-col bg-bg border border-blue/20 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-blue/20">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-blue" />
          <span className="text-[13px] font-semibold text-dark">Event Tape</span>
          {!loading && (
            <span className="text-[11px] text-slate-500 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
              {events.length} events
            </span>
          )}
        </div>

        {/* Live pulse */}
        {!loading && events.length > 0 && (
          <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Live
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 px-3 py-2 border-b border-white/5 overflow-x-auto scrollbar-none">
        {FILTER_TABS.map((tab) => {
          const count =
            tab === "ALL" ? events.length : events.filter((e) => FILTER_MAP[tab].includes(e.type)).length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all ${
                activeTab === tab
                  ? "bg-blue/10 text-blue border-blue/30"
                  : "text-slate-500 border-transparent hover:text-slate-300 hover:bg-white/5"
              }`}
            >
              {tab}
              {count > 0 && (
                <span
                  className={`ml-1.5 text-[10px] ${
                    activeTab === tab ? "text-blue/70" : "text-slate-600"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ maxHeight: 500 }}
      >
        {loading ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
            <Activity size={28} className="text-slate-700 mb-3" />
            <p className="text-[13px] text-slate-500">No events detected yet.</p>
            <p className="text-[11px] text-slate-600 mt-1">
              Engine analyses data after each 3-min bar.
            </p>
          </div>
        ) : (
          filtered.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </div>
  );
}
