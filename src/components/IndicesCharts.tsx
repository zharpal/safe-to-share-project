import { useEffect, useRef, useState, useCallback } from "react";
import * as echarts from "echarts";
import { RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Bar3 { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface VwapPoint { time: number; value: number; }
interface SpurtDetail { time: number; strikes: number[]; }
interface ChartData { bars: Bar3[]; vwap: VwapPoint[]; spurtDetails: SpurtDetail[]; noToken?: boolean; }
interface OptionLevels {
  maxCeOI: { strike: number; oi: number };
  maxPeOI: { strike: number; oi: number };
  maxPain: { strike: number };
}

const CHART_GROUP = "indices-sync";

// ── Helpers ───────────────────────────────────────────────────────────────────
function getISTDateStr(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function istTimeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}

function istFullLabel(ms: number): string {
  return new Date(ms).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });
}

// Returns [firstBarMs, lastBarMs + 6min] for the latest session
// Uses ACTUAL bar bounds — no dead space on either side.
function latestSessionRange(bars: Bar3[]): [number, number] | null {
  if (!bars.length) return null;
  const latestDate = getISTDateStr(bars[bars.length - 1].time);
  const sessionBars = bars.filter(b => getISTDateStr(b.time) === latestDate);
  if (!sessionBars.length) return null;
  const startMs = sessionBars[0].time;
  // End at last actual bar + 6 min breathing room.
  // Using 15:30 IST future caused a large dead zone on the right.
  const lastBarMs = sessionBars[sessionBars.length - 1].time;
  const endMs = Math.min(
    lastBarMs + 6 * 60 * 1000,
    new Date(`${latestDate}T15:30:00+05:30`).getTime()
  );
  return [startMs, endMs];
}

// Unique 9:15 AM timestamps for each trading day in the bar set
function sessionStartTimestamps(bars: Bar3[]): number[] {
  const dates = [...new Set(bars.map(b => getISTDateStr(b.time)))];
  return dates.map(d => new Date(`${d}T09:15:00+05:30`).getTime());
}

// ── ECharts option builder ────────────────────────────────────────────────────
function buildOption(
  data: ChartData,
  label: string,
  lineColor: string,
  levels: OptionLevels | null
): echarts.EChartsOption {
  const { bars, vwap, spurtDetails } = data;

  const range = latestSessionRange(bars);
  const dayStarts = sessionStartTimestamps(bars);

  // Price line series data
  const priceData: [number, number][] = bars.map(b => [b.time, b.close]);
  const vwapData:  [number, number][] = vwap.map(v => [v.time, v.value]);

  // Spurt dots: closest bar within ±5 min tolerance
  const spurtData: [number, number][] = spurtDetails.reduce<[number, number][]>((acc, s) => {
    let closest: Bar3 | null = null;
    let minDiff = 5 * 60 * 1000;
    for (const b of bars) {
      const diff = Math.abs(b.time - s.time);
      if (diff < minDiff) { minDiff = diff; closest = b; }
    }
    if (closest) acc.push([closest.time, closest.close]);
    return acc;
  }, []);

  // Day separator markLines — thin vertical lines at each session open
  const separatorMarkLines = dayStarts.map(ts => ({
    xAxis: ts,
    lineStyle: { color: "rgba(0,0,0,0.06)", width: 1, type: "solid" as const },
    label: {
      show: true,
      formatter: getISTDateStr(ts).slice(5), // MM-DD
      position: "insideStartTop" as const,
      fontSize: 9,
      color: "rgba(0,0,0,0.18)",
    },
  }));

  // Option level markLines — horizontal dashed lines for CE/PE OI walls & MaxPain
  // Hosted on a separate invisible series so they always render regardless of
  // the price series markLine mixing behavior.
  const levelMarkLines: any[] = levels ? [
    {
      yAxis: levels.maxCeOI.strike,
      lineStyle: { color: "#ef4444", type: "dashed" as const, width: 1.5, opacity: 0.8 },
      label: {
        show: true,
        formatter: `CE Wall  ${levels.maxCeOI.strike.toLocaleString("en-IN")}`,
        position: "insideEndBottom" as const,
        fontSize: 9.5,
        fontWeight: "bold" as const,
        color: "#ef4444",
        backgroundColor: "rgba(255,255,255,0.85)",
        padding: [2, 4],
        borderRadius: 2,
      },
    },
    {
      yAxis: levels.maxPeOI.strike,
      lineStyle: { color: "#22c55e", type: "dashed" as const, width: 1.5, opacity: 0.8 },
      label: {
        show: true,
        formatter: `PE Wall  ${levels.maxPeOI.strike.toLocaleString("en-IN")}`,
        position: "insideEndTop" as const,
        fontSize: 9.5,
        fontWeight: "bold" as const,
        color: "#22c55e",
        backgroundColor: "rgba(255,255,255,0.85)",
        padding: [2, 4],
        borderRadius: 2,
      },
    },
    {
      yAxis: levels.maxPain.strike,
      lineStyle: { color: "#f59e0b", type: "dotted" as const, width: 2, opacity: 0.9 },
      label: {
        show: true,
        formatter: `MaxPain  ${levels.maxPain.strike.toLocaleString("en-IN")}`,
        position: "insideEndBottom" as const,
        fontSize: 9.5,
        fontWeight: "bold" as const,
        color: "#b45309",
        backgroundColor: "rgba(255,255,255,0.85)",
        padding: [2, 4],
        borderRadius: 2,
      },
    },
  ] : [];

  return {
    animation: true,
    animationDuration: 400,
    animationEasing: "cubicOut" as const,
    animationDurationUpdate: 300,
    animationEasingUpdate: "cubicOut" as const,
    backgroundColor: "#ffffff",
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        crossStyle: { color: lineColor, width: 1, opacity: 0.35 },
        label: { backgroundColor: lineColor, fontSize: 10, padding: [3, 6] },
      },
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#e5e7eb",
      borderWidth: 1,
      shadowBlur: 16,
      shadowColor: "rgba(0,0,0,0.07)",
      textStyle: { fontSize: 11, color: "#374151" },
      padding: [8, 12],
      formatter(params: any) {
        if (!Array.isArray(params) || !params[0]) return "";
        const t = params[0].axisValue as number;
        const lines: string[] = [
          `<div style="font-size:10px;color:#9ca3af;margin-bottom:5px;font-weight:600">${istTimeLabel(t)}</div>`,
        ];
        for (const p of params) {
          if (p.seriesName === "Vol Spurt" || p.seriesName === "_levels") continue;
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          if (v == null) continue;
          lines.push(
            `<div style="display:flex;justify-content:space-between;gap:20px;line-height:1.8">` +
            `<span>${p.marker}${p.seriesName}</span>` +
            `<b>${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</b></div>`
          );
        }
        const spurt = spurtDetails.find(s => Math.abs(s.time - t) < 5 * 60 * 1000);
        if (spurt) {
          lines.push(
            `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #f3f4f6;color:#d97706;font-size:10px">` +
            `⚡ Synchronized Vol Spurt · ${spurt.strikes.length} strikes</div>`
          );
        }
        return `<div style="min-width:160px">${lines.join("")}</div>`;
      },
    },
    legend: {
      data: [label, "VWAP", "Vol Spurt"],
      top: 4, right: 12,
      textStyle: { fontSize: 10, color: "#6b7280" },
      icon: "circle",
      itemWidth: 8, itemHeight: 8,
      itemGap: 14,
    },
    grid: { left: 12, right: 88, bottom: 52, top: 36, containLabel: false },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "#f3f4f6" } },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10, color: "#9ca3af", margin: 8,
        formatter(value: number) { return istTimeLabel(value); },
      },
      splitLine: { show: false },
      // Hard-clamp left edge to first real bar of today so the axis can
      // never drift left into overnight / pre-market empty space.
      min: range ? range[0] : undefined,
    },
    yAxis: {
      type: "value",
      scale: true,
      position: "right",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10, color: "#9ca3af", margin: 10,
        formatter: (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 0 }),
      },
      splitLine: { lineStyle: { color: "#f9fafb", type: "solid", width: 1 } },
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: "shift",
        preventDefaultMouseMove: false,
        // Start at first real bar of today, end at 15:30 IST
        ...(range ? { startValue: range[0], endValue: range[1] } : {}),
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 20,
        bottom: 4,
        borderColor: "#f3f4f6",
        fillerColor: `${lineColor}12`,
        handleStyle: { color: lineColor, borderColor: lineColor },
        handleSize: "80%",
        textStyle: { fontSize: 9, color: "#9ca3af" },
        ...(range ? { startValue: range[0], endValue: range[1] } : {}),
      },
    ],
    series: [
      // ── Price line ───────────────────────────────────────────────────────
      {
        name: label,
        type: "line",
        data: priceData,
        smooth: 0.2,
        symbol: "none",
        lineStyle: { color: lineColor, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0,   color: `${lineColor}28` },
            { offset: 0.7, color: `${lineColor}06` },
            { offset: 1,   color: `${lineColor}00` },
          ]),
        },
        // Only separator lines (vertical xAxis lines) on the price series
        markLine: {
          silent: true, symbol: "none", animation: false,
          data: separatorMarkLines,
        },
        z: 4,
      },
      // ── VWAP ─────────────────────────────────────────────────────────────
      {
        name: "VWAP",
        type: "line",
        data: vwapData,
        smooth: 0.2,
        symbol: "none",
        lineStyle: { color: "#10b981", width: 1.5, type: "dashed" },
        itemStyle: { color: "#10b981" },
        z: 3,
      },
      // ── OI level horizontal lines — separate invisible host series ────────
      // Keeping them separate from the price series guarantees they render
      // independently of the vertical separator lines.
      {
        name: "_levels",
        type: "line",
        data: [],
        silent: true,
        legendHoverLink: false,
        markLine: levelMarkLines.length ? {
          silent: true, symbol: "none", animation: false,
          z: 6,
          data: levelMarkLines,
        } : undefined,
        z: 1,
      },
      // ── Volume spurt dots (effectScatter with ripple) ─────────────────────
      {
        name: "Vol Spurt",
        type: "effectScatter",
        coordinateSystem: "cartesian2d",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: spurtData,
        symbol: "circle",
        symbolSize: 10,
        rippleEffect: {
          brushType: "stroke",
          scale: 3.5,
          period: 2,
          color: "#f59e0b",
        },
        itemStyle: {
          color: "#f59e0b",
          borderColor: "#ffffff",
          borderWidth: 2,
          shadowBlur: 8,
          shadowColor: "rgba(245,158,11,0.6)",
        },
        z: 12,
        showEffectOn: "render",
      },
    ],
  };
}

// ── Single chart component ────────────────────────────────────────────────────
function IndexChart({
  index,
  label,
  color,
  showLevels,
  onSpurts,
}: {
  index: "nifty" | "sensex";
  label: string;
  color: string;
  showLevels: boolean;
  onSpurts: (details: SpurtDetail[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<echarts.ECharts | null>(null);
  const initialised  = useRef(false);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState("");
  const [lastPrice, setLastPrice]   = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchAndRender = useCallback(async () => {
    try {
      const [chartRes, levelsRes] = await Promise.all([
        fetch(`/api/charts/${index}`),
        showLevels ? fetch("/api/option-levels") : Promise.resolve(null),
      ]);

      const data: ChartData = await chartRes.json();
      const levels: OptionLevels | null = levelsRes?.ok ? await levelsRes.json() : null;

      if (data.noToken) { setError("Connect Upstox to view live charts"); setLoading(false); return; }
      if (!data.bars.length) { setError("No data yet"); setLoading(false); return; }

      setError("");
      setLastPrice(data.bars[data.bars.length - 1].close);
      setLastUpdate(new Date());
      onSpurts(data.spurtDetails || []);

      const chart = chartRef.current;
      if (!chart) return;

      // First render: notMerge=true for a clean slate (no stale series).
      // Subsequent renders: notMerge=false so dataZoom pan/zoom state is preserved.
      const option = buildOption(data, label, color, levels);
      chart.setOption(option, { notMerge: !initialised.current });
      initialised.current = true;
    } catch {
      setError("Fetch error");
    } finally {
      setLoading(false);
    }
  }, [index, label, color, showLevels, onSpurts]);

  // Initialise chart once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = echarts.init(container, undefined, { renderer: "svg" });
    chart.group = CHART_GROUP;
    echarts.connect(CHART_GROUP);
    chartRef.current = chart;
    initialised.current = false;

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(container);

    // Horizontal scroll → pan
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const opt = chart.getOption() as any;
      const dz  = Array.isArray(opt.dataZoom) ? opt.dataZoom[0] : null;
      if (!dz) return;
      const visible = (dz.endValue as number) - (dz.startValue as number);
      const shift   = (e.deltaX / container.clientWidth) * visible;
      chart.dispatchAction({
        type: "dataZoom", dataZoomIndex: 0,
        startValue: (dz.startValue as number) + shift,
        endValue:   (dz.endValue   as number) + shift,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    fetchAndRender();
    const id = setInterval(fetchAndRender, 3 * 60 * 1000);

    return () => {
      clearInterval(id);
      ro.disconnect();
      container.removeEventListener("wheel", onWheel);
      chart.dispose();
    };
  }, [fetchAndRender]);

  return (
    <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden flex flex-col shadow-sm h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
          <span className="text-sm font-bold text-gray-800">{label}</span>
          {loading && <RefreshCw size={11} className="animate-spin text-gray-400" />}
        </div>
        <div className="flex items-center gap-3">
          {error ? (
            <span className="text-xs text-amber-600 font-medium">{error}</span>
          ) : lastPrice ? (
            <span className="text-sm font-mono font-semibold text-gray-800">
              {lastPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
          ) : null}
          {lastUpdate && (
            <span className="text-[10px] text-gray-400 font-mono">
              {lastUpdate.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </span>
          )}
          <button
            onClick={fetchAndRender}
            className="p-1 rounded hover:bg-gray-50 transition-colors text-gray-400 hover:text-gray-600"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
      {/* Chart canvas — flex-1 + explicit 100% so SVG fills the card */}
      <div ref={containerRef} className="flex-1 w-full" style={{ minHeight: 0 }} />
    </div>
  );
}

// ── Spurt detail panel ────────────────────────────────────────────────────────
function SpurtPanel({
  niftySpurts,
  sensexSpurts,
}: {
  niftySpurts: SpurtDetail[];
  sensexSpurts: SpurtDetail[];
}) {
  const rows: { time: number; index: string; color: string; strikes: number[] }[] = [
    ...niftySpurts.map(s => ({ ...s, index: "Nifty 50", color: "#2563eb" })),
    ...sensexSpurts.map(s => ({ ...s, index: "Sensex",  color: "#c2410c" })),
  ].sort((a, b) => b.time - a.time);

  if (!rows.length) {
    return (
      <div className="bg-white border border-gray-100 rounded-2xl px-4 py-2.5 text-xs text-gray-400 text-center shrink-0 flex items-center justify-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-300 inline-block" />
        No synchronized volume spurt events detected yet
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden shrink-0">
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        <span className="text-xs font-bold text-gray-700">Synchronized Volume Spurt Events</span>
        <span className="text-xs text-gray-400 ml-1">
          ({rows.length} · ATM±500 all strikes · scroll to see all)
        </span>
      </div>
      <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 120 }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-50 sticky top-0 bg-white z-10">
              <th className="px-3 py-1.5 text-left font-semibold text-gray-500 w-36">Time (IST)</th>
              <th className="px-3 py-1.5 text-left font-semibold text-gray-500 w-20">Index</th>
              <th className="px-3 py-1.5 text-left font-semibold text-gray-500">Strikes (all in ATM±500)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={`${row.index}-${row.time}`}
                className={i % 2 === 0 ? "bg-white" : "bg-gray-50/40"}
              >
                <td className="px-3 py-1 font-mono text-gray-600 whitespace-nowrap">
                  {istFullLabel(row.time)}
                </td>
                <td className="px-3 py-1 whitespace-nowrap">
                  <span
                    className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold text-white"
                    style={{ background: row.color }}
                  >
                    {row.index}
                  </span>
                </td>
                <td className="px-3 py-1 font-mono text-gray-700 leading-relaxed">
                  {row.strikes.map(s => s.toLocaleString("en-IN")).join(", ")}
                  <span className="ml-2 text-gray-400">({row.strikes.length} strikes)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export function IndicesCharts() {
  const [niftySpurts, setNiftySpurts]   = useState<SpurtDetail[]>([]);
  const [sensexSpurts, setSensexSpurts] = useState<SpurtDetail[]>([]);

  return (
    <div className="p-4 flex flex-col gap-3" style={{ height: "calc(100vh - 136px)" }}>
      {/* Charts grid — flex-1 so they take all remaining height */}
      <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
        <IndexChart
          index="nifty"
          label="Nifty 50"
          color="#2563eb"
          showLevels={true}
          onSpurts={setNiftySpurts}
        />
        <IndexChart
          index="sensex"
          label="Sensex"
          color="#c2410c"
          showLevels={false}
          onSpurts={setSensexSpurts}
        />
      </div>
      {/* Spurt panel — fixed height at bottom */}
      <SpurtPanel niftySpurts={niftySpurts} sensexSpurts={sensexSpurts} />
    </div>
  );
}
