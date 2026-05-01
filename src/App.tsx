import { useState, useEffect, useRef } from "react";
import { SpotTicker } from "./components/SpotTicker";
import { ParticipantDataView } from "./components/ParticipantData";
import { StrikeTimeline } from "./components/StrikeTimeline";
import { WsTimeline } from "./components/WsTimeline";
import { OptionChain } from "./components/OptionChain";
import { IndicesCharts } from "./components/IndicesCharts";
import { Settings, Activity, BarChart2, List, LogIn, CheckCircle, XCircle, Loader2, Zap, Copy, Check, LineChart, Brain, TrendingUp, CloudUpload, History, Download, Radio, AlertTriangle, BellRing, TestTube2 } from "lucide-react";
import { SmartMoneyAI } from "./components/SmartMoneyAI";
import { SensexTimeline } from "./components/SensexTimeline";
import { DeepSeekChat } from "./components/DeepSeekChat";
import { FlowIntelligence } from "./components/FlowIntelligence";
import { ExportCenter } from "./components/ExportCenter";
import { AlertCenter } from "./components/AlertCenter";
import { BacktestCenter } from "./components/BacktestCenter";

// ── NSE Holidays (keep in sync with server.ts NSE_HOLIDAYS) ────────────────
const NSE_HOLIDAYS = new Set([
  // 2025
  "2025-01-26","2025-02-26","2025-03-14","2025-04-14","2025-04-18",
  "2025-05-01","2025-08-15","2025-10-02","2025-10-20","2025-10-21",
  "2025-11-05","2025-12-25",
  // 2026 — verify remaining lunar-calendar holidays vs NSE circular
  "2026-01-26","2026-03-04","2026-04-03","2026-04-14",
  "2026-05-01","2026-08-15","2026-10-02","2026-12-25",
]);

function getMarketStatus(): { open: boolean; label: string; minutesLeft: number } {
  const now = new Date();
  const dayStr = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" });
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (dayStr === "Sat" || dayStr === "Sun" || NSE_HOLIDAYS.has(dateStr)) {
    return { open: false, label: "Market Closed", minutesLeft: 0 };
  }
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === "hour")!.value);
  const m = parseInt(parts.find(p => p.type === "minute")!.value);
  const mins = h * 60 + m;
  const openMins  = 9 * 60 + 15;
  const closeMins = 15 * 60 + 30;
  if (mins < openMins) {
    const left = openMins - mins;
    return { open: false, label: `Opens in ${left}m`, minutesLeft: left };
  }
  if (mins < closeMins) {
    const left = closeMins - mins;
    return { open: true, label: `Closes in ${left}m`, minutesLeft: left };
  }
  return { open: false, label: "Market Closed", minutesLeft: 0 };
}


export default function App() {
  const [activeTab, setActiveTab] = useState<"timeline" | "live" | "sensex" | "charts" | "eod" | "chain" | "ai" | "flow" | "alerts" | "backtest" | "export">("timeline");
  const [marketStatus, setMarketStatus] = useState(getMarketStatus);
  const marketTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [captureStale, setCaptureStale] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    marketTimerRef.current = setInterval(() => setMarketStatus(getMarketStatus()), 30_000);
    return () => { if (marketTimerRef.current) clearInterval(marketTimerRef.current); };
  }, []);

  // Poll capture health every 60s during market hours to surface token expiry
  useEffect(() => {
    const check = () => {
      if (!getMarketStatus().open) return;
      fetch("/api/capture-health")
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return;
          setCaptureStale(d.stale);
          setCaptureError(d.lastError);
        })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [adminStatus, setAdminStatus] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminLoginStatus, setAdminLoginStatus] = useState<"idle" | "saving" | "error">("idle");
  const [accessToken, setAccessToken] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [oauthRedirectUri, setOauthRedirectUri] = useState("");
  const [uriCopied, setUriCopied] = useState(false);
  const [exportStatus, setExportStatus] = useState<{
    status: "idle" | "running" | "success" | "error";
    lastDate: string | null;
    lastTime: string | null;
    fileCount: number;
    error: string | null;
    historicalStatus: "idle" | "running" | "success" | "error";
    historicalError: string | null;
    historicalDatesUploaded: number;
  } | null>(null);
  const [googleAuth, setGoogleAuth] = useState<{
    connected: boolean;
    clientConfigured: boolean;
    redirectUri: string;
    mode: "oauth" | "service_account" | "none";
    serviceAccountConfigured: boolean;
    serviceAccountEmail: string;
  } | null>(null);

  const refreshAuthStatus = () => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => setIsAuthenticated(data.authenticated))
      .catch(() => {});
  };

  const refreshAdminStatus = () => {
    fetch("/api/admin/status")
      .then((r) => r.json())
      .then(setAdminStatus)
      .catch(() => {});
  };

  const refreshGoogleAuth = () => {
    fetch("/api/google/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setGoogleAuth(data))
      .catch(() => setGoogleAuth(null));
  };

  const refreshExportStatus = () => {
    fetch("/api/export/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setExportStatus(data))
      .catch(() => setExportStatus(null));
  };

  // Check auth/admin status on mount + detect Google OAuth redirect return
  useEffect(() => {
    refreshAuthStatus();
    refreshAdminStatus();

    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected") === "1") {
      refreshGoogleAuth();
      // Clean the URL without reloading
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("google_error")) {
      console.error("[google oauth] error:", params.get("google_error"));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Listen for Upstox OAuth popup success
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setIsAuthenticated(true);
        window.location.reload();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    if (!adminStatus?.authenticated) {
      setGoogleAuth(null);
      setExportStatus(null);
      return;
    }
    refreshGoogleAuth();
    refreshExportStatus();
  }, [adminStatus?.authenticated]);

  // Fetch the redirect URI once on settings open (so user knows what to register in Upstox)
  useEffect(() => {
    if (!isSettingsOpen || !adminStatus?.authenticated || oauthRedirectUri) return;
    fetch("/api/auth/upstox/url")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.redirectUri) setOauthRedirectUri(d.redirectUri); })
      .catch(() => {});
  }, [isSettingsOpen, adminStatus?.authenticated, oauthRedirectUri]);

  // Poll export status
  useEffect(() => {
    if (!adminStatus?.authenticated) return;
    const poll = () => {
      refreshExportStatus();
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [adminStatus?.authenticated]);

  // Opens Upstox login page in a new tab + opens the settings modal for token paste.
  // Once logged in, user generates/copies their access token from account.upstox.com
  // and pastes it into the settings modal below.
  const handleUpstoxLogin = () => {
    setIsSettingsOpen(true);
    if (adminStatus?.authenticated) {
      window.open("https://account.upstox.com", "_blank");
    }
  };

  const copyRedirectUri = () => {
    if (!oauthRedirectUri) return;
    navigator.clipboard.writeText(oauthRedirectUri).then(() => {
      setUriCopied(true);
      setTimeout(() => setUriCopied(false), 2000);
    });
  };

  const handleAdminLogin = async () => {
    if (!adminPassword.trim()) return;
    setAdminLoginStatus("saving");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      if (!res.ok) throw new Error("Invalid admin password");
      setAdminPassword("");
      setAdminLoginStatus("idle");
      refreshAdminStatus();
      refreshAuthStatus();
      refreshGoogleAuth();
      refreshExportStatus();
    } catch (error) {
      console.error("Admin login error:", error);
      setAdminLoginStatus("error");
    }
  };

  const handleAdminLogout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setAdminStatus((prev) => prev ? { ...prev, authenticated: false } : { configured: true, authenticated: false });
    setAdminPassword("");
    setGoogleAuth(null);
    setExportStatus(null);
    setOauthRedirectUri("");
    setAdminLoginStatus("idle");
  };

  const handleSaveToken = async () => {
    if (!accessToken.trim()) return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: accessToken.trim() }),
      });
      if (!res.ok) throw new Error("Failed to save token");
      setSaveStatus("success");
      refreshAuthStatus();
      setTimeout(() => {
        setIsSettingsOpen(false);
        setSaveStatus("idle");
        setAccessToken("");
      }, 1000);
    } catch (error) {
      console.error("Token save error:", error);
      setSaveStatus("error");
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setIsAuthenticated(false);
    setSaveStatus("idle");
  };

  const handleExportNow = async () => {
    await fetch("/api/export/run", { method: "POST" });
    refreshExportStatus();
  };

  const handleExportHistorical = async () => {
    await fetch("/api/export/historical", { method: "POST" });
    refreshExportStatus();
  };

  const handleConnectGoogle = async () => {
    const res = await fetch("/api/google/auth/start", { method: "POST" });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.url) {
      window.location.href = data.url;
    }
  };

  const handleDisconnectGoogle = async () => {
    await fetch("/api/google/auth/disconnect", { method: "POST" });
    setGoogleAuth(g => g ? { ...g, connected: false } : null);
  };

  return (
    <div className="min-h-screen bg-bg text-dark font-sans selection:bg-blue/30">
      {/* Top Ticker */}
      <SpotTicker />

      {/* Header & Navigation */}
      <header className="sticky top-0 z-40 header-gradient backdrop-blur-md border-b border-blue/15 px-4 py-3 shadow-sm">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-3">

          {/* Brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="bg-blue/10 p-1.5 rounded-lg border border-blue/20">
              <Activity className="text-blue" size={20} />
            </div>
            <div className="leading-tight">
              <h1 className="text-base font-bold tracking-tight text-dark">OC-Flows</h1>
              <p className="text-[9px] uppercase tracking-widest text-blue/80 font-bold">Smart Money · Option Flows</p>
            </div>
            {/* Market status pill */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
              marketStatus.open
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-dark/5 border-dark/10 text-dark/50"
            }`}>
              {marketStatus.open
                ? <span className="live-dot" style={{ width: 6, height: 6 }} />
                : <Radio size={10} />}
              {marketStatus.label}
            </div>
            {/* Capture stale warning — shown when market is open but data stopped flowing */}
            {marketStatus.open && captureStale && (
              <div
                title={captureError ? `Last error: ${captureError}` : "No data captured in the last 5 minutes — Upstox token may have expired."}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border bg-amber-50 border-amber-300 text-amber-700 cursor-default"
              >
                <AlertTriangle size={11} />
                Data stalled — re-login Upstox
              </div>
            )}
          </div>

          {/* Tab navigation */}
          <nav className="flex items-center gap-0.5 bg-white/45 p-0.5 rounded-xl border border-blue/10 shadow-sm overflow-x-auto">
            {([
              { id: "timeline", icon: Activity,    label: "3-Min",     color: "blue"   },
              { id: "live",     icon: Zap,          label: "1-Min",     color: "blue"   },
              { id: "sensex",   icon: TrendingUp,   label: "Sensex",    color: "orange" },
              { id: "charts",   icon: LineChart,    label: "Indices",   color: "blue"   },
              { id: "chain",    icon: List,         label: "Chain",     color: "blue"   },
              { id: "eod",      icon: BarChart2,    label: "EOD Data",  color: "blue"   },
              { id: "ai",       icon: Brain,        label: "Smart AI",  color: "violet" },
              { id: "flow",     icon: Zap,          label: "Flow Intel",color: "amber"  },
              { id: "alerts",   icon: BellRing,     label: "Alerts",    color: "rose"   },
              { id: "backtest", icon: TestTube2,    label: "Backtest",  color: "indigo" },
              { id: "export",   icon: Download,     label: "Export",    color: "blue"   },
            ] as const).map(({ id, icon: Icon, label, color }) => {
              const active = activeTab === id;
              const activeColors: Record<string, string> = {
                blue:   "bg-white text-blue border-blue/15 shadow-sm",
                orange: "bg-white text-orange-600 border-orange-200 shadow-sm",
                violet: "bg-white text-violet-600 border-violet-200 shadow-sm",
                amber:  "bg-white text-amber-600 border-amber-200 shadow-sm",
                rose:   "bg-white text-rose-600 border-rose-200 shadow-sm",
              };
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id as typeof activeTab)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 whitespace-nowrap border ${
                    active
                      ? activeColors[color]
                      : "border-transparent text-dark/60 hover:text-dark hover:bg-white/60"
                  }`}
                >
                  <Icon size={13} />
                  {label}
                </button>
              );
            })}
          </nav>

          {/* Right side — status badges + actions */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Data source badge */}
            {isAuthenticated ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                <CheckCircle size={12} className="text-emerald-600" />
                <span className="text-[11px] font-bold text-emerald-700">Live</span>
                {adminStatus?.authenticated && (
                  <button onClick={handleLogout} className="text-emerald-400 hover:text-emerald-700 text-[10px] ml-0.5 underline">
                    off
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <XCircle size={12} className="text-amber-500" />
                <span className="text-[11px] font-bold text-amber-700">Mock</span>
              </div>
            )}

            <button
              onClick={handleUpstoxLogin}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#522D8F] text-white rounded-lg text-xs font-medium hover:bg-[#3f226e] transition-colors shadow-sm"
            >
              <LogIn size={13} />
              {adminStatus?.authenticated ? "Upstox Login" : "Admin"}
            </button>

            {/* Drive export status badge */}
            {adminStatus?.authenticated && exportStatus && (
              <button
                onClick={() => setIsSettingsOpen(true)}
                title={
                  exportStatus.status === "success"
                    ? `Last exported: ${exportStatus.lastDate} (${exportStatus.fileCount} files)`
                    : exportStatus.status === "error"
                    ? `Export error: ${exportStatus.error}`
                    : exportStatus.status === "running"
                    ? "Exporting to Drive…"
                    : "Drive export idle"
                }
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                  exportStatus.status === "success"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                    : exportStatus.status === "error"
                    ? "bg-rose-50 border-rose-200 text-rose-700"
                    : exportStatus.status === "running"
                    ? "bg-blue-50 border-blue/20 text-blue"
                    : "bg-white/50 border-blue/10 text-dark/50"
                }`}
              >
                {exportStatus.status === "running" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : exportStatus.status === "success" ? (
                  <CheckCircle size={12} />
                ) : exportStatus.status === "error" ? (
                  <XCircle size={12} />
                ) : (
                  <CloudUpload size={12} />
                )}
                {exportStatus.status === "success" && exportStatus.lastDate
                  ? exportStatus.lastDate
                  : exportStatus.status === "running"
                  ? "Uploading…"
                  : exportStatus.status === "error"
                  ? "Failed"
                  : "Drive"}
              </button>
            )}

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 text-dark/60 hover:text-blue hover:bg-white/60 rounded-lg transition-colors border border-transparent hover:border-blue/20"
            >
              <Settings size={18} />
            </button>
          </div>

        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-[1600px] mx-auto pb-24">
        <div className={activeTab === "timeline" ? "tab-panel-enter" : "hidden"}><StrikeTimeline /></div>
        <div className={activeTab === "live"     ? "tab-panel-enter" : "hidden"}><WsTimeline /></div>
        <div className={activeTab === "sensex"   ? "tab-panel-enter" : "hidden"}><SensexTimeline /></div>
        <div className={activeTab === "charts"   ? "tab-panel-enter" : "hidden"}><IndicesCharts /></div>
        <div className={activeTab === "eod"      ? "tab-panel-enter" : "hidden"}><ParticipantDataView /></div>
        <div className={activeTab === "chain"    ? "tab-panel-enter" : "hidden"}><OptionChain /></div>
        <div className={activeTab === "ai"       ? "tab-panel-enter" : "hidden"}><SmartMoneyAI /></div>
        <div className={activeTab === "flow"     ? "tab-panel-enter" : "hidden"}><FlowIntelligence /></div>
        <div className={activeTab === "alerts"   ? "tab-panel-enter" : "hidden"}><AlertCenter /></div>
        <div className={activeTab === "backtest" ? "tab-panel-enter" : "hidden"}><BacktestCenter /></div>
        <div className={activeTab === "export"   ? "tab-panel-enter" : "hidden"}><ExportCenter /></div>
      </main>

      {/* DeepSeek Floating Chat */}
      <DeepSeekChat />

      {/* Settings / Token Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark/60 backdrop-blur-sm p-4">
          <div className="bg-bg border border-blue/20 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-blue/10 bg-white/50">
              <h2 className="text-xl font-bold text-dark">Admin Settings</h2>
              <p className="text-sm text-dark/70 mt-1">
                Sensitive integrations are locked behind an admin session.
              </p>
            </div>
            <div className="p-6 space-y-4">
              {adminStatus === null ? (
                <div className="flex items-center gap-2 rounded-lg border border-blue/10 bg-white/60 px-4 py-3 text-sm text-dark/70">
                  <Loader2 size={14} className="animate-spin" />
                  Checking admin session…
                </div>
              ) : !adminStatus.configured ? (
                <>
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Set <strong>ADMIN_PASSWORD</strong> in Railway to unlock token management, Google Drive authorisation, and export controls.
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => setIsSettingsOpen(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-dark/70 hover:text-dark hover:bg-white transition-colors border border-transparent hover:border-blue/20"
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : !adminStatus.authenticated ? (
                <>
                  <div className="rounded-xl border border-blue/10 bg-white/60 p-4 text-sm text-dark/70">
                    Enter the admin password to manage the shared Upstox and Google Drive integrations.
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-blue uppercase tracking-wider">
                      Admin Password
                    </label>
                    <input
                      type="password"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      className="w-full bg-white border border-blue/20 rounded-lg px-4 py-2 text-dark focus:outline-none focus:border-blue focus:ring-1 focus:ring-blue transition-all"
                      placeholder="Enter admin password"
                      autoFocus
                    />
                  </div>
                  {adminLoginStatus === "error" && (
                    <div className="flex items-center gap-2 text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded-lg px-4 py-2">
                      <XCircle size={14} />
                      Invalid admin password.
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-dark/50">Only admin-authenticated sessions can modify integrations.</span>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setIsSettingsOpen(false)}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-dark/70 hover:text-dark hover:bg-white transition-colors border border-transparent hover:border-blue/20"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleAdminLogin}
                        disabled={!adminPassword.trim() || adminLoginStatus === "saving"}
                        className="px-4 py-2 rounded-lg text-sm font-bold bg-blue text-white hover:bg-dark transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {adminLoginStatus === "saving" && <Loader2 size={14} className="animate-spin" />}
                        {adminLoginStatus === "saving" ? "Unlocking…" : "Unlock Settings"}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    <div className="flex items-center gap-2">
                      <CheckCircle size={14} />
                      <span>Admin session active</span>
                    </div>
                    <button onClick={handleAdminLogout} className="text-xs underline hover:text-emerald-900">
                      sign out
                    </button>
                  </div>

                  {oauthRedirectUri && (
                    <div className="space-y-1.5 bg-amber-50 border border-amber-200 rounded-xl p-4">
                      <p className="text-[11px] font-bold text-amber-800 uppercase tracking-wider">
                        Step 1 — Register this Redirect URI in Upstox Developer Console
                      </p>
                      <p className="text-[11px] text-amber-700">
                        If using OAuth: go to <strong>developer.upstox.com</strong> → Your App → Edit → set <em>Redirect URL</em> to exactly:
                      </p>
                      <div className="flex items-center gap-2 bg-white border border-amber-200 rounded-lg px-3 py-2">
                        <code className="text-[11px] text-dark font-mono flex-1 break-all">{oauthRedirectUri}</code>
                        <button
                          onClick={copyRedirectUri}
                          className="shrink-0 text-amber-600 hover:text-amber-900 transition-colors"
                          title="Copy URI"
                        >
                          {uriCopied ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                      <p className="text-[11px] text-amber-700">
                        Or: click <strong>Login with Upstox</strong> → it opens <em>account.upstox.com</em> where you can generate a token → paste it below.
                      </p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-blue uppercase tracking-wider">
                      Paste Access Token
                    </label>
                    <textarea
                      value={accessToken}
                      onChange={(e) => setAccessToken(e.target.value)}
                      rows={4}
                      className="w-full bg-white border border-blue/20 rounded-lg px-4 py-2 text-dark focus:outline-none focus:border-blue focus:ring-1 focus:ring-blue transition-all font-mono text-xs resize-none"
                      placeholder="Paste your Upstox access token here..."
                      autoFocus
                    />
                    <p className="text-[11px] text-dark/50">
                      The active Upstox token is stored server-side for background capture and export jobs.
                      Get your token from <span className="font-bold text-blue">Upstox Developer Console</span>.
                    </p>
                  </div>

                  {saveStatus === "error" && (
                    <div className="flex items-center gap-2 text-rose-600 text-sm bg-rose-50 border border-rose-200 rounded-lg px-4 py-2">
                      <XCircle size={14} />
                      Failed to save token. Please try again.
                    </div>
                  )}

                  {saveStatus === "success" && (
                    <div className="flex items-center gap-2 text-emerald-600 text-sm bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
                      <CheckCircle size={14} />
                      Token saved.
                    </div>
                  )}

                  <div className="pt-2 flex items-center justify-between">
                    <span className="text-xs text-dark/50">This token powers the shared live-data backend.</span>
                    <div className="flex gap-3">
                      <button
                        onClick={() => { setIsSettingsOpen(false); setSaveStatus("idle"); setAccessToken(""); }}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-dark/70 hover:text-dark hover:bg-white transition-colors border border-transparent hover:border-blue/20"
                      >
                        Close
                      </button>
                      <button
                        onClick={handleSaveToken}
                        disabled={!accessToken.trim() || saveStatus === "saving" || saveStatus === "success"}
                        className="px-4 py-2 rounded-lg text-sm font-bold bg-blue text-white hover:bg-dark transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {saveStatus === "saving" && <Loader2 size={14} className="animate-spin" />}
                        {saveStatus === "saving" ? "Saving…" : "Save Token"}
                      </button>
                    </div>
                  </div>

                  <div className="border-t border-blue/10 pt-4 space-y-2">
                    <p className="text-xs font-bold text-blue uppercase tracking-wider">Google Drive</p>
                    {googleAuth?.connected ? (
                      <div className="flex items-center justify-between px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                        <div className="flex items-center gap-2 text-xs text-emerald-700">
                          <CheckCircle size={13} />
                          <span>
                            {googleAuth.mode === "service_account"
                              ? "Service account configured — exports upload without Google sign-in"
                              : "Connected — uploads to your Google Drive"}
                          </span>
                        </div>
                        {googleAuth.mode === "oauth" && (
                          <button onClick={handleDisconnectGoogle} className="text-xs text-emerald-500 hover:text-emerald-800 underline ml-2">disconnect</button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                          <XCircle size={13} />
                          <span>Not connected — exports will fail until authorised</span>
                        </div>
                        <button
                          onClick={handleConnectGoogle}
                          disabled={!googleAuth?.clientConfigured}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-blue/20 text-dark/70 hover:text-dark hover:border-blue/40 transition-colors w-full justify-center"
                        >
                          <CloudUpload size={13} />
                          Connect Google Drive
                        </button>
                        <p className="text-[10px] text-dark/40 leading-relaxed">
                          Needs <strong>GOOGLE_CLIENT_ID</strong> + <strong>GOOGLE_CLIENT_SECRET</strong> env vars.
                          In Google Cloud Console → APIs &amp; Services → Credentials → OAuth 2.0 Client (Web), add authorised redirect URI:
                          <br /><code className="bg-black/5 px-1 rounded break-all">{googleAuth?.redirectUri || `${window.location.origin}/api/google/auth/callback`}</code>
                        </p>
                      </div>
                    )}
                    {googleAuth?.mode === "service_account" && (
                      <div className="rounded-lg border border-blue/10 bg-white/60 px-3 py-2 text-[11px] text-dark/60">
                        Using <strong>GDRIVE_SERVICE_ACCOUNT_JSON</strong>.
                        {googleAuth.serviceAccountEmail && (
                          <> Share the target Drive folder with <code className="bg-black/5 px-1 rounded">{googleAuth.serviceAccountEmail}</code>.</>
                        )}
                      </div>
                    )}
                  </div>

                  {exportStatus && (
                    <div className="border-t border-blue/10 pt-4 space-y-3">
                      <p className="text-xs font-bold text-blue uppercase tracking-wider">Export Controls</p>

                      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                        exportStatus.status === "success"
                          ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                          : exportStatus.status === "error"
                          ? "bg-rose-50 border-rose-200 text-rose-700"
                          : exportStatus.status === "running"
                          ? "bg-blue-50 border-blue/20 text-blue"
                          : "bg-white/60 border-blue/10 text-dark/60"
                      }`}>
                        {exportStatus.status === "running" ? (
                          <Loader2 size={13} className="animate-spin shrink-0" />
                        ) : exportStatus.status === "success" ? (
                          <CheckCircle size={13} className="shrink-0" />
                        ) : exportStatus.status === "error" ? (
                          <XCircle size={13} className="shrink-0" />
                        ) : (
                          <CloudUpload size={13} className="shrink-0" />
                        )}
                        <span className="flex-1">
                          {exportStatus.status === "success"
                            ? `Last export: ${exportStatus.lastDate} — ${exportStatus.fileCount} files`
                            : exportStatus.status === "error"
                            ? `Export failed: ${exportStatus.error}`
                            : exportStatus.status === "running"
                            ? "Exporting today's data to Drive…"
                            : "No export yet today"}
                        </span>
                      </div>

                      {exportStatus.historicalStatus !== "idle" && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                          exportStatus.historicalStatus === "success"
                            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                            : exportStatus.historicalStatus === "error"
                            ? "bg-rose-50 border-rose-200 text-rose-700"
                            : "bg-blue-50 border-blue/20 text-blue"
                        }`}>
                          {exportStatus.historicalStatus === "running" ? (
                            <Loader2 size={13} className="animate-spin shrink-0" />
                          ) : exportStatus.historicalStatus === "success" ? (
                            <CheckCircle size={13} className="shrink-0" />
                          ) : (
                            <XCircle size={13} className="shrink-0" />
                          )}
                          <span>
                            {exportStatus.historicalStatus === "running"
                              ? `Uploading historical data… ${exportStatus.historicalDatesUploaded} date(s) done`
                              : exportStatus.historicalStatus === "success"
                              ? `Historical upload complete — ${exportStatus.historicalDatesUploaded} date(s)`
                              : `Historical upload failed: ${exportStatus.historicalError}`}
                          </span>
                        </div>
                      )}

                      <div className="flex gap-2">
                        <button
                          onClick={handleExportNow}
                          disabled={exportStatus.status === "running"}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-blue text-white hover:bg-dark transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {exportStatus.status === "running" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <CloudUpload size={12} />
                          )}
                          Export Today
                        </button>
                        <button
                          onClick={handleExportHistorical}
                          disabled={exportStatus.historicalStatus === "running"}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-blue/20 text-dark/70 hover:text-dark hover:border-blue/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {exportStatus.historicalStatus === "running" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <History size={12} />
                          )}
                          Upload Historical Data
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
