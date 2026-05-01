import { useEffect, useRef, useState } from "react";
import { BellRing, RefreshCw, CheckCircle2, AlertTriangle, ShieldAlert, Volume2, VolumeX } from "lucide-react";

type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";
type Severity = "INFO" | "WATCH" | "HIGH" | "CRITICAL";

interface FlowAlert {
  id: string;
  createdAt: string;
  isoTimestamp: string;
  timestamp: string;
  underlying: string;
  strike: number;
  timeframe: "1m" | "3m";
  type: string;
  direction: Direction;
  severity: Severity;
  score: number;
  spot: number;
  title: string;
  message: string;
  metrics: {
    spotChg?: number;
    callCOI?: number;
    putCOI?: number;
    callPremiumRoc?: number;
    putPremiumRoc?: number;
    callOiRatio?: number;
    putOiRatio?: number;
    premiumEfficiency?: number;
    [key: string]: any;
  };
  acknowledged: boolean;
}

interface AlertResponse {
  ok: boolean;
  minCoi: number;
  minSpotMove: number;
  maxStrikeDistance: number;
  volumeLookback?: number;
  minVolZscore?: number;
  minVolRatio?: number;
  trapWaitMs?: number;
  highVolumeDedupeMs?: number;
  scanAllStrikes?: boolean;
  niftyMinVolume?: number;
  sensexMinVolume?: number;
  atmRangeSteps?: number;
  alerts: FlowAlert[];
}

const IST = "Asia/Kolkata";

function inrNum(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return Math.round(value).toLocaleString("en-IN");
}

function signed(value: number | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: IST,
  });
}

function colorForDirection(direction: Direction): string {
  if (direction === "BULLISH") return "bg-emerald-50 border-emerald-200 text-emerald-700";
  if (direction === "BEARISH") return "bg-rose-50 border-rose-200 text-rose-700";
  return "bg-slate-50 border-slate-200 text-slate-700";
}

function colorForSeverity(severity: Severity): string {
  if (severity === "CRITICAL") return "bg-red-600 text-white";
  if (severity === "HIGH") return "bg-rose-100 text-rose-700";
  if (severity === "WATCH") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

function playAlertBeep() {
  try {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.5);
  } catch {
    // ignore audio failures
  }
}

export function AlertCenter() {
  const [alerts, setAlerts] = useState<FlowAlert[]>([]);
  const [config, setConfig] = useState<{ minCoi: number; minSpotMove: number; maxStrikeDistance: number; volumeLookback?: number; minVolZscore?: number; minVolRatio?: number; trapWaitMs?: number; highVolumeDedupeMs?: number; scanAllStrikes?: boolean; niftyMinVolume?: number; sensexMinVolume?: number; atmRangeSteps?: number } | null>(null);
  const [directionFilter, setDirectionFilter] = useState<"ALL" | Direction>("ALL");
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem("flowAlertsNotify") === "1");
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/flow-alerts?limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AlertResponse = await res.json();
      setAlerts(data.alerts || []);
      setConfig({
        minCoi: data.minCoi,
        minSpotMove: data.minSpotMove,
        maxStrikeDistance: data.maxStrikeDistance,
        volumeLookback: data.volumeLookback,
        minVolZscore: data.minVolZscore,
        minVolRatio: data.minVolRatio,
        trapWaitMs: data.trapWaitMs,
        highVolumeDedupeMs: data.highVolumeDedupeMs,
        scanAllStrikes: data.scanAllStrikes,
        niftyMinVolume: data.niftyMinVolume,
        sensexMinVolume: data.sensexMinVolume,
        atmRangeSteps: data.atmRangeSteps,
      });
      setLastUpdated(new Date());
    } catch (error) {
      console.error("Failed to load flow alerts:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
    const timer = setInterval(fetchAlerts, 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (alerts.length === 0) return;

    if (!initializedRef.current) {
      alerts.forEach((a) => seenIdsRef.current.add(a.id));
      initializedRef.current = true;
      return;
    }

    const fresh = alerts.filter((a) => !seenIdsRef.current.has(a.id));
    if (fresh.length === 0) return;

    fresh.forEach((a) => seenIdsRef.current.add(a.id));

    const top = fresh[0];
    if (notificationsEnabled) {
      playAlertBeep();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(top.title, {
          body: top.message,
          tag: top.id,
        });
      }
    }
  }, [alerts, notificationsEnabled]);

  const enableNotifications = async () => {
    if (!("Notification" in window)) {
      setNotificationsEnabled(false);
      localStorage.removeItem("flowAlertsNotify");
      return;
    }
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    setNotificationsEnabled(enabled);
    if (enabled) {
      localStorage.setItem("flowAlertsNotify", "1");
      playAlertBeep();
    } else {
      localStorage.removeItem("flowAlertsNotify");
    }
  };

  const disableNotifications = () => {
    setNotificationsEnabled(false);
    localStorage.removeItem("flowAlertsNotify");
  };

  const ack = async (id: string) => {
    try {
      await fetch(`/api/flow-alerts/${id}/ack`, { method: "POST" });
      setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, acknowledged: true } : a));
    } catch (error) {
      console.error("Failed to acknowledge alert:", error);
    }
  };

  const filteredAlerts = alerts.filter((a) => directionFilter === "ALL" || a.direction === directionFilter);
  const activeAlerts = alerts.filter((a) => !a.acknowledged);
  const latestCritical = activeAlerts.find((a) => a.severity === "CRITICAL" || a.severity === "HIGH");

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600">
              <BellRing size={22} />
            </div>
            <div>
              <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">Flow Alerts</h2>
              <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
                Immediate SD200 high-volume event, 5-minute trap validation, and CE/PE BUY alerts.
              </p>
            </div>
          </div>
          <p className="text-xs text-dark/40 font-mono mt-2">
            {config
              ? `Rules: instant SD${config.volumeLookback || 200} volume info · Z >= ${config.minVolZscore || 2.5} or Vol/SD >= ${config.minVolRatio || 6} · ${config.scanAllStrikes ? "all strikes" : `ATM +/- ${config.atmRangeSteps ?? 1}`} · wait ${Math.round((config.trapWaitMs || 300000) / 60000)} min for BUY confirmation`
              : "Loading alert rules..."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-dark/50 font-mono px-2">
              Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}

          <button
            onClick={fetchAlerts}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-blue hover:border-blue/40 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>

          {notificationsEnabled ? (
            <button
              onClick={disableNotifications}
              className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-sm font-bold text-emerald-700 hover:bg-emerald-100 transition-colors shadow-sm"
            >
              <Volume2 size={14} />
              Sound On
            </button>
          ) : (
            <button
              onClick={enableNotifications}
              className="flex items-center gap-2 px-3 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-dark/70 hover:text-blue hover:border-blue/40 transition-colors shadow-sm"
            >
              <VolumeX size={14} />
              Enable Sound
            </button>
          )}
        </div>
      </div>

      {latestCritical && (
        <div className={`rounded-3xl border p-4 shadow-sm ${colorForDirection(latestCritical.direction)}`}>
          <div className="flex items-start gap-3">
            <ShieldAlert size={22} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider ${colorForSeverity(latestCritical.severity)}`}>
                  {latestCritical.severity}
                </span>
                <span className="text-xs font-black uppercase tracking-wider">{latestCritical.direction}</span>
                <span className="text-xs font-black uppercase tracking-wider">{latestCritical.underlying} {latestCritical.strike}</span>
                <span className="text-xs font-mono opacity-70">{formatDateTime(latestCritical.isoTimestamp)}</span>
              </div>
              <h3 className="mt-1 text-lg font-black">{latestCritical.title}</h3>
              <p className="mt-1 text-sm font-medium">{latestCritical.message}</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white/70 rounded-2xl border border-blue/10 p-4 shadow-sm">
          <p className="text-xs text-dark/50 font-bold uppercase tracking-wider">Total Alerts</p>
          <p className="text-2xl font-black text-dark mt-1">{alerts.length}</p>
        </div>
        <div className="bg-white/70 rounded-2xl border border-rose-100 p-4 shadow-sm">
          <p className="text-xs text-dark/50 font-bold uppercase tracking-wider">Bearish</p>
          <p className="text-2xl font-black text-rose-600 mt-1">{alerts.filter((a) => a.direction === "BEARISH").length}</p>
        </div>
        <div className="bg-white/70 rounded-2xl border border-emerald-100 p-4 shadow-sm">
          <p className="text-xs text-dark/50 font-bold uppercase tracking-wider">Bullish</p>
          <p className="text-2xl font-black text-emerald-600 mt-1">{alerts.filter((a) => a.direction === "BULLISH").length}</p>
        </div>
        <div className="bg-white/70 rounded-2xl border border-amber-100 p-4 shadow-sm">
          <p className="text-xs text-dark/50 font-bold uppercase tracking-wider">Unacknowledged</p>
          <p className="text-2xl font-black text-amber-600 mt-1">{activeAlerts.length}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {(["ALL", "BEARISH", "BULLISH", "NEUTRAL"] as const).map((filter) => (
          <button
            key={filter}
            onClick={() => setDirectionFilter(filter)}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all border ${
              directionFilter === filter
                ? "bg-blue text-white border-blue shadow-md"
                : "bg-white text-dark/70 border-blue/20 hover:border-blue/40 hover:text-dark"
            }`}
          >
            {filter}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filteredAlerts.length === 0 && (
          <div className="bg-white/70 rounded-3xl border border-blue/10 p-8 text-center text-dark/50">
            <AlertTriangle size={24} className="mx-auto mb-2 opacity-40" />
            <p className="font-bold">No alerts yet.</p>
            <p className="text-sm mt-1">Alerts will start appearing after live 1-minute bars are captured during market hours.</p>
          </div>
        )}

        {filteredAlerts.map((alert) => (
          <div
            key={alert.id}
            className={`rounded-3xl border p-4 shadow-sm bg-white/80 ${alert.acknowledged ? "opacity-60" : ""}`}
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider ${colorForSeverity(alert.severity)}`}>
                    {alert.severity}
                  </span>
                  <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-wider ${colorForDirection(alert.direction)}`}>
                    {alert.direction}
                  </span>
                  <span className="px-2 py-0.5 rounded-lg bg-blue/10 text-blue text-[10px] font-black uppercase tracking-wider">
                    {alert.underlying} {alert.strike}
                  </span>
                  <span className="text-xs font-mono text-dark/50">{formatDateTime(alert.isoTimestamp)}</span>
                  <span className="text-xs font-mono text-dark/50">{alert.timeframe}</span>
                  {alert.acknowledged && (
                    <span className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCircle2 size={12} />
                      Ack
                    </span>
                  )}
                </div>

                <h3 className="mt-2 text-base font-black text-dark">{alert.title}</h3>
                <p className="mt-1 text-sm text-dark/75 font-medium leading-relaxed">{alert.message}</p>

                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 text-[11px]">
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">Spot</p>
                    <p className="font-mono font-bold text-dark">{alert.spot.toFixed(2)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">Spot Δ</p>
                    <p className="font-mono font-bold text-dark">{signed(alert.metrics.spotChg)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">CE COI</p>
                    <p className="font-mono font-bold text-dark">{inrNum(alert.metrics.callCOI)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">CE PΔ</p>
                    <p className="font-mono font-bold text-dark">{signed(alert.metrics.callPremiumRoc)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">PE COI</p>
                    <p className="font-mono font-bold text-dark">{inrNum(alert.metrics.putCOI)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">PE PΔ</p>
                    <p className="font-mono font-bold text-dark">{signed(alert.metrics.putPremiumRoc)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">Side</p>
                    <p className="font-mono font-bold text-dark">{alert.metrics.triggerSide || "-"}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">Score</p>
                    <p className="font-mono font-bold text-dark">{alert.score}/100</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">Type</p>
                    <p className="font-mono font-bold text-dark truncate" title={alert.type}>{alert.type}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">CE Vol Z</p>
                    <p className="font-mono font-bold text-dark">{signed(alert.metrics.callVolZ)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5">
                    <p className="text-dark/40 font-bold uppercase">PE Vol Z</p>
                    <p className="font-mono font-bold text-dark">{signed(alert.metrics.putVolZ)}</p>
                  </div>
                </div>
              </div>

              {!alert.acknowledged && (
                <button
                  onClick={() => ack(alert.id)}
                  className="px-3 py-2 rounded-xl border border-blue/20 text-blue bg-white hover:bg-blue/5 text-xs font-bold transition-colors"
                >
                  Acknowledge
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
