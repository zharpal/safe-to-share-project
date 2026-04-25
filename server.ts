import "dotenv/config";
import express, { type CookieOptions, type Request, type Response } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import ExcelJS from "exceljs";
import archiver from "archiver";
import { upstoxAutoLogin } from "./upstox-auto-login.js";

// ── Flow Intelligence Engine imports ─────────────────────────────────────────
import { computeAllFeatures, computeBreadthScore, computeDirectionalEfficiency, computeIvTrend } from "./engine/features.js";
import { detectEventsForStrike, computeAnomalies, type EventDetectionContext } from "./engine/events.js";
import { classifyRegime } from "./engine/regime.js";
import { detectWalls, wallMigrationToEvent } from "./engine/walls.js";
import { generateNotebook } from "./engine/notebook.js";
import { extractSpotHistory, detectLargeMoves, inferMoveStart, extractPreMoveWindows, buildMoveInstance } from "./engine/moves.js";
import { buildFeatureVector, createPatternFromMove, findPatternMatches, updatePatternReliability, prunePatterns } from "./engine/patterns.js";
import { computeSessionSignature, findSimilarDays } from "./engine/similarity.js";
import type { FlowEvent, FlowState, RegimeSummary, WallState, NotebookEntry, MoveInstance, PrecursorPattern, SessionSignature, AnomalyEntry } from "./engine/types.js";
import fs from "fs";
import { Pool } from "pg";

// ── Constants ────────────────────────────────────────────────────────────────
const LOT_SIZE = 65;        // Nifty 50 lot size (Tuesday weekly expiry)
const SENSEX_LOT_SIZE = 20; // BSE Sensex lot size
const MAX_HISTORY_DAYS = 7;
const MAX_HISTORY_MS = MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
const SERVER_SECRETS_FILE = path.join(process.cwd(), "data", "server-secrets.json");
const APP_SECRETS_TABLE = "app_secrets";
const ADMIN_SESSION_COOKIE = "admin_session";
const UPSTOX_OAUTH_STATE_COOKIE = "upstox_oauth_state";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type SecretSnapshot = {
  upstoxToken: string;
};

const secretState: SecretSnapshot = {
  upstoxToken: process.env.UPSTOX_API_TOKEN || "",
};

function normalizeSecretSnapshot(raw: unknown): Partial<SecretSnapshot> {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const upstoxToken = typeof value.upstoxToken === "string" ? value.upstoxToken : undefined;
  return { upstoxToken };
}

function readSecretsFromDisk(): Partial<SecretSnapshot> {
  try {
    if (!fs.existsSync(SERVER_SECRETS_FILE)) return {};
    return normalizeSecretSnapshot(JSON.parse(fs.readFileSync(SERVER_SECRETS_FILE, "utf-8")));
  } catch (e: any) {
    console.error("[secrets] failed to read local store:", e.message);
    return {};
  }
}

function writeSecretsToDisk(snapshot: SecretSnapshot) {
  try {
    fs.mkdirSync(path.dirname(SERVER_SECRETS_FILE), { recursive: true });
    fs.writeFileSync(SERVER_SECRETS_FILE, JSON.stringify(snapshot, null, 2));
  } catch (e: any) {
    console.error("[secrets] failed to persist local store:", e.message);
  }
}


async function ensureSecretsTable(): Promise<void> {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ${APP_SECRETS_TABLE} (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadSecretsFromDatabase(): Promise<Partial<SecretSnapshot>> {
  if (!pgPool) return {};
  const { rows } = await pgPool.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ${APP_SECRETS_TABLE}`
  );
  const snapshot: Partial<SecretSnapshot> = {};
  for (const row of rows) {
    if (row.key === "upstoxToken" && typeof row.value === "string") {
      snapshot.upstoxToken = row.value;
    }
  }
  return snapshot;
}

async function persistSecretSnapshot(): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO ${APP_SECRETS_TABLE} (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ["upstoxToken", JSON.stringify(secretState.upstoxToken || "")]
    );
    return;
  }
  writeSecretsToDisk(secretState);
}

async function bootstrapSecretState(): Promise<void> {
  const diskSecrets = readSecretsFromDisk();

  if (pgPool) {
    await ensureSecretsTable();
    const dbSecrets = await loadSecretsFromDatabase();
    secretState.upstoxToken = dbSecrets.upstoxToken || diskSecrets.upstoxToken || secretState.upstoxToken;
    await persistSecretSnapshot();
    return;
  }

  secretState.upstoxToken = diskSecrets.upstoxToken || secretState.upstoxToken;
  writeSecretsToDisk(secretState);
}

function getConfiguredUpstoxToken(): string {
  return secretState.upstoxToken || process.env.UPSTOX_API_TOKEN || "";
}

function hasConfiguredUpstoxToken(): boolean {
  const token = getConfiguredUpstoxToken();
  return !!token && token !== "YOUR_UPSTOX_API_TOKEN";
}

async function setConfiguredUpstoxToken(token: string): Promise<void> {
  secretState.upstoxToken = token.trim();
  activeToken = getConfiguredUpstoxToken();
  await persistSecretSnapshot();
}

async function clearConfiguredUpstoxToken(): Promise<void> {
  secretState.upstoxToken = "";
  activeToken = getConfiguredUpstoxToken();
  await persistSecretSnapshot();
}


function adminPassword(): string {
  return process.env.ADMIN_PASSWORD?.trim() || "";
}

function adminSessionSecret(): string {
  return process.env.ADMIN_SESSION_SECRET?.trim() || adminPassword();
}

function adminConfigured(): boolean {
  return adminPassword().length > 0;
}

function secureCookieOptions(maxAge: number): CookieOptions {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

function clearCookieOptions(): CookieOptions {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  };
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signValue(value: string): string {
  return crypto.createHmac("sha256", adminSessionSecret()).update(value).digest("base64url");
}

function issueAdminSession(res: Response) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + ADMIN_SESSION_TTL_MS }),
    "utf-8"
  ).toString("base64url");
  const signature = signValue(payload);
  res.cookie(ADMIN_SESSION_COOKIE, `${payload}.${signature}`, secureCookieOptions(ADMIN_SESSION_TTL_MS));
}

function clearAdminSession(res: Response) {
  res.clearCookie(ADMIN_SESSION_COOKIE, clearCookieOptions());
}

function isAdminAuthenticated(req: Request): boolean {
  if (!adminConfigured()) return false;
  const raw = req.cookies?.[ADMIN_SESSION_COOKIE];
  if (!raw || typeof raw !== "string") return false;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const expected = signValue(payload);
  if (!timingSafeEqualString(signature, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!adminConfigured()) {
    res.status(503).json({ error: "ADMIN_PASSWORD is not configured." });
    return false;
  }
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required." });
    return false;
  }
  return true;
}

function issueOauthState(res: Response, cookieName: string): string {
  const state = crypto.randomBytes(32).toString("hex");
  res.cookie(cookieName, state, secureCookieOptions(OAUTH_STATE_TTL_MS));
  return state;
}

function consumeOauthState(req: Request, res: Response, cookieName: string, received: string | undefined): boolean {
  const expected = req.cookies?.[cookieName];
  res.clearCookie(cookieName, clearCookieOptions());
  if (!expected || !received) return false;
  return timingSafeEqualString(expected, received);
}

// ── PostgreSQL persistent storage (Neon / any free Postgres) ─────────────────
// Set DATABASE_URL in Railway env vars.  Works with Neon, CockroachDB, etc.
// Falls back to local JSON files when DATABASE_URL is absent (local dev).
let pgPool: Pool | null = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required by Neon / most hosted Postgres
    max: 3,
  });
  // Create table if it doesn't exist yet
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS timeline_bars (
      strike   INTEGER NOT NULL,
      iso_ts   TEXT    NOT NULL,
      bar_data JSONB   NOT NULL,
      PRIMARY KEY (strike, iso_ts)
    )
  `).then(() => console.log("[timeline] storage: PostgreSQL (DATABASE_URL)"))
    .catch((e: Error) => console.error("[timeline] DB init error:", e.message));
} else {
  console.log("[timeline] storage: local JSON files (set DATABASE_URL to persist)");
}

// ── Local JSON fallback ───────────────────────────────────────────────────────
const DATA_DIR = process.env.TIMELINE_DATA_DIR || path.join(process.cwd(), "timeline-data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFilePath(strike: number) {
  return path.join(DATA_DIR, `timeline-${strike}.json`);
}
function loadFromDisk(strike: number): any[] {
  try {
    const file = dataFilePath(strike);
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}
function saveToDisk(strike: number, data: any[]) {
  try { fs.writeFileSync(dataFilePath(strike), JSON.stringify(data), "utf-8"); } catch {}
}

// ── In-memory cache ───────────────────────────────────────────────────────────
const timelineStore = new Map<number, any[]>();

function pruneOld(entries: any[]): any[] {
  const cutoff = Date.now() - MAX_HISTORY_MS;
  return entries.filter(
    (e) => e.isoTimestamp && new Date(e.isoTimestamp).getTime() >= cutoff
  );
}

async function loadFromDB(strike: number): Promise<any[]> {
  if (!pgPool) return [];
  try {
    const cutoff = new Date(Date.now() - MAX_HISTORY_MS).toISOString();
    const { rows } = await pgPool.query(
      `SELECT bar_data FROM timeline_bars WHERE strike=$1 AND iso_ts>=$2 ORDER BY iso_ts DESC`,
      [strike, cutoff]
    );
    return rows.map((r: any) => r.bar_data);
  } catch (e: any) {
    console.error("[db] load error:", e.message);
    return [];
  }
}

function saveToDB(strike: number, point: any) {
  if (!pgPool) return;
  pgPool.query(
    `INSERT INTO timeline_bars (strike, iso_ts, bar_data) VALUES ($1,$2,$3)
     ON CONFLICT (strike, iso_ts) DO UPDATE SET bar_data=EXCLUDED.bar_data`,
    [strike, point.isoTimestamp, point]
  ).catch((e: Error) => console.error("[db] upsert error:", e.message));
}

// Get or warm the in-memory cache for a strike
async function getHistoryAsync(strike: number): Promise<any[]> {
  if (!timelineStore.has(strike)) {
    const rows = pgPool ? await loadFromDB(strike) : loadFromDisk(strike);
    timelineStore.set(strike, pruneOld(rows));
  }
  return timelineStore.get(strike)!;
}

// Sync getter used inside the live-capture loop (cache must be warm already)
function getHistory(strike: number): any[] {
  return timelineStore.get(strike) || [];
}

// Append a new bar, deduplicate within 2.5 min (so bars are ~3-min spaced), persist to both backends
async function appendToHistory(strike: number, point: any): Promise<any[]> {
  const history = await getHistoryAsync(strike);
  if (history.length > 0 && history[0].isoTimestamp) {
    const lastMs = new Date(history[0].isoTimestamp).getTime();
    const nowMs  = new Date(point.isoTimestamp).getTime();
    if (Math.abs(nowMs - lastMs) < 150_000) return history; // 2.5 min dedup for 3-min bars
  }
  history.unshift(point);
  const pruned = pruneOld(history);
  timelineStore.set(strike, pruned);
  saveToDB(strike, point);      // async, fire-and-forget
  saveToDisk(strike, pruned);   // local backup
  return pruned;
}

// ── NSE Trading Holidays (IST) ────────────────────────────────────────────────
// Official NSE exchange holidays. Verify against NSE circular each year.
// Source: NSE India holiday list (https://www.nseindia.com)
const NSE_HOLIDAYS = new Set([
  // 2025 — confirmed from NSE circular
  "2025-01-26", // Republic Day
  "2025-02-26", // Mahashivratri
  "2025-03-14", // Holi
  "2025-04-14", // Dr. Ambedkar Jayanti
  "2025-04-18", // Good Friday
  "2025-05-01", // Maharashtra Day
  "2025-08-15", // Independence Day
  "2025-10-02", // Mahatma Gandhi Jayanti / Dussehra
  "2025-10-20", // Diwali Laxmi Puja
  "2025-10-21", // Diwali — Balipratipada
  "2025-11-05", // Prakash Gurpurb Sri Guru Nanak Dev Ji
  "2025-12-25", // Christmas
  // 2026 — verify against official NSE circular for 2026
  "2026-01-26", // Republic Day
  "2026-03-04", // Holi (Phalguna Purnima 2026)
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-08-15", // Independence Day
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-12-25", // Christmas
  // NOTE: Diwali, Dussehra, Prakash Gurpurb dates for 2026 are lunar-
  // calendar dependent. Add them once NSE publishes the official circular.
]);

// ── Market Hours (IST) ────────────────────────────────────────────────────────
function getISTMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour")!.value);
  const m = parseInt(parts.find(p => p.type === "minute")!.value);
  return h * 60 + m;
}

function isMarketOpen(): boolean {
  const now = new Date();
  const todayIST = getISTDateStr(now);

  // Weekend check — use arithmetic offset (IST = UTC+5:30) for locale independence
  const istDayOfWeek = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
  if (istDayOfWeek === 0 || istDayOfWeek === 6) return false; // 0=Sun, 6=Sat

  // NSE holidays
  if (NSE_HOLIDAYS.has(todayIST)) return false;

  // Trading hours: 9:15 AM to strictly before 3:30 PM IST
  const mins = getISTMinutes();
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// ── Live (1-min) bar storage ──────────────────────────────────────────────────
const liveStore = new Map<number, any[]>();
const LIVE_MAX_MS = 24 * 60 * 60 * 1000;

if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS live_bars (
      strike   INTEGER NOT NULL,
      iso_ts   TEXT    NOT NULL,
      bar_data JSONB   NOT NULL,
      PRIMARY KEY (strike, iso_ts)
    )
  `).catch((e: Error) => console.error("[timeline] live_bars init:", e.message));
}

function pruneLive(entries: any[]): any[] {
  const cutoff = Date.now() - LIVE_MAX_MS;
  return entries.filter(e => e.isoTimestamp && new Date(e.isoTimestamp).getTime() >= cutoff);
}

async function getLiveHistoryAsync(strike: number): Promise<any[]> {
  if (!liveStore.has(strike)) {
    let rows: any[] = [];
    if (pgPool) {
      try {
        const cutoff = new Date(Date.now() - LIVE_MAX_MS).toISOString();
        const { rows: dbRows } = await pgPool.query(
          `SELECT bar_data FROM live_bars WHERE strike=$1 AND iso_ts>=$2 ORDER BY iso_ts DESC`,
          [strike, cutoff]
        );
        rows = dbRows.map((r: any) => r.bar_data);
      } catch (e: any) { console.error("[db] live load:", e.message); }
    }
    liveStore.set(strike, pruneLive(rows));
  }
  return liveStore.get(strike)!;
}

function getLiveHistory(strike: number): any[] {
  return liveStore.get(strike) || [];
}

async function appendLiveHistory(strike: number, point: any): Promise<any[]> {
  const history = await getLiveHistoryAsync(strike);
  if (history.length > 0 && history[0].isoTimestamp) {
    const lastMs = new Date(history[0].isoTimestamp).getTime();
    const nowMs  = new Date(point.isoTimestamp).getTime();
    if (Math.abs(nowMs - lastMs) < 30_000) return history; // 30s dedup
  }
  history.unshift(point);
  const pruned = pruneLive(history);
  liveStore.set(strike, pruned);
  if (pgPool) {
    pgPool.query(
      `INSERT INTO live_bars (strike, iso_ts, bar_data) VALUES ($1,$2,$3)
       ON CONFLICT (strike, iso_ts) DO UPDATE SET bar_data=EXCLUDED.bar_data`,
      [strike, point.isoTimestamp, point]
    ).catch((e: Error) => console.error("[db] live upsert:", e.message));
  }
  return pruned;
}

// ── Shared bar-building utilities ────────────────────────────────────────────

// True when prev bar is from a different IST calendar day — forces COI = 0
function isNewTradingDay(prev: any): boolean {
  if (!prev?.isoTimestamp) return true;
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  return fmt(new Date(prev.isoTimestamp)) !== fmt(new Date());
}

// Build a bar point from raw Upstox strikeData + previous stored bar
function buildPoint(strikeData: any, prevBar: any, lotSize: number = LOT_SIZE): any {
  const callData   = strikeData.call_options?.market_data   || {};
  const putData    = strikeData.put_options?.market_data    || {};
  const callGreeks = strikeData.call_options?.option_greeks || {};
  const putGreeks  = strikeData.put_options?.option_greeks  || {};

  const now = new Date();
  const isoTimestamp = now.toISOString();
  const timestamp = now.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  });

  // "First bar of the session" — either no history or crossing midnight into a new day
  const isFirstBar = !prevBar || isNewTradingDay(prevBar);

  const callOI     = callData.oi     || 0;
  const putOI      = putData.oi      || 0;
  const callVolCum = callData.volume || 0;
  const putVolCum  = putData.volume  || 0;
  const callIv     = parseFloat((callGreeks.iv || 0).toFixed(2));
  const putIv      = parseFloat((putGreeks.iv  || 0).toFixed(2));
  const callLtp    = parseFloat((callData.ltp  || 0).toFixed(2));
  const putLtp     = parseFloat((putData.ltp   || 0).toFixed(2));

  const callCOI  = isFirstBar ? 0 : callOI - (prevBar.call.rawOI || 0);
  const putCOI   = isFirstBar ? 0 : putOI  - (prevBar.put.rawOI  || 0);
  const callVol3 = isFirstBar ? callVolCum : Math.max(0, callVolCum - (prevBar.call.rawVol || 0));
  const putVol3  = isFirstBar ? putVolCum  : Math.max(0, putVolCum  - (prevBar.put.rawVol  || 0));

  const callCoiVol = (!isFirstBar && callVol3 > 0) ? (callCOI / callVol3).toFixed(4) : "0.0000";
  const putCoiVol  = (!isFirstBar && putVol3  > 0) ? (putCOI  / putVol3).toFixed(4) : "0.0000";
  const callTqNt   = Math.round(callVol3 / lotSize).toString();
  const putTqNt    = Math.round(putVol3  / lotSize).toString();
  const callIvRoc   = isFirstBar ? "0.00" : (callIv  - parseFloat(prevBar.call.iv)).toFixed(2);
  const putIvRoc    = isFirstBar ? "0.00" : (putIv   - parseFloat(prevBar.put.iv)).toFixed(2);
  const callPremRoc = isFirstBar ? "0.00" : (callLtp - parseFloat(prevBar.call.ltp)).toFixed(2);
  const putPremRoc  = isFirstBar ? "0.00" : (putLtp  - parseFloat(prevBar.put.ltp)).toFixed(2);

  return {
    isoTimestamp, timestamp,
    spot: (strikeData.underlying_spot_price || 0).toFixed(2),
    call: { rawOI: callOI, rawVol: callVolCum, oi: callOI, coi: callCOI, volDelta: callVol3,
            coiVolRatio: callCoiVol, tqNtRatio: callTqNt, iv: callIv.toFixed(2),
            ivRoc: callIvRoc, ltp: callLtp.toFixed(2), premiumRoc: callPremRoc },
    put:  { rawOI: putOI,  rawVol: putVolCum,  oi: putOI,  coi: putCOI,  volDelta: putVol3,
            coiVolRatio: putCoiVol,  tqNtRatio: putTqNt,  iv: putIv.toFixed(2),
            ivRoc: putIvRoc,  ltp: putLtp.toFixed(2),  premiumRoc: putPremRoc },
    reading: smartMoneyReading(callCOI, parseFloat(callPremRoc), putCOI, parseFloat(putPremRoc), isFirstBar),
  };
}

// ── Server-owned Upstox token cache (for background poller) ──────────────────
let activeToken: string = getConfiguredUpstoxToken();

// ── Capture health tracking ───────────────────────────────────────────────────
let lastCaptureSuccessAt: number | null = null;
let lastCaptureError: string | null = null;
let lastCaptureErrorAt: number | null = null;

function extractApiError(e: any): string {
  const status = e?.response?.status || e?.status;
  const msg    = e?.response?.data?.errors?.[0]?.message || e?.message || "unknown error";
  return status ? `HTTP ${status}: ${msg}` : msg;
}

// ── Weekly expiry cache (avoid fetching contracts every 3 min) ────────────────
let cachedExpiry: string = "";
let expiryFetchedAt    = 0;

async function getWeeklyExpiry(token: string): Promise<string> {
  if (cachedExpiry && Date.now() - expiryFetchedAt < 15 * 60 * 1000) return cachedExpiry; // 15-min cache
  const res = await axios.get(
    "https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX|Nifty%2050",
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
  );
  const expiriesSet = new Set<string>();
  (res.data?.data || []).forEach((c: any) => { if (c.expiry) expiriesSet.add(c.expiry); });
  const sorted = Array.from(expiriesSet).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const weekly = pickWeeklyExpiries(sorted);
  cachedExpiry = weekly[0] || sorted[0] || "";
  expiryFetchedAt = Date.now();
  console.log(`[expiry] selected ${cachedExpiry} (${weekly.length} Thursday expiries available: ${weekly.slice(0,3).join(", ")})`);
  return cachedExpiry;
}

// ── Background poller: capture ALL strikes every 3 min during market hours ───
// One option-chain API call covers every strike simultaneously.
async function captureAllStrikes(): Promise<void> {
  if (!isMarketOpen() || !activeToken || activeToken === "YOUR_UPSTOX_API_TOKEN") return;
  try {
    const expiry = await getWeeklyExpiry(activeToken);
    if (!expiry) return;

    const chainRes = await axios.get(
      `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${expiry}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${activeToken}` } }
    );

    const allStrikes: any[] = chainRes.data?.data || [];

    for (const sd of allStrikes) {
      const strike: number = sd.strike_price;
      await getHistoryAsync(strike); // warm cache
      const prev = getHistory(strike)[0];
      const point = buildPoint(sd, prev);
      await appendToHistory(strike, point);

      // Also capture for live (1-min) store
      await getLiveHistoryAsync(strike);
      const prevLive = getLiveHistory(strike)[0];
      const livePoint = buildPoint(sd, prevLive);
      await appendLiveHistory(strike, livePoint);
    }

    lastCaptureSuccessAt = Date.now();
    lastCaptureError     = null;
    lastCaptureErrorAt   = null;
  } catch (e: any) {
    const msg = extractApiError(e);
    lastCaptureError   = msg;
    lastCaptureErrorAt = Date.now();
    console.error(`[bg] captureAllStrikes failed: ${msg}`);
  }
}

// ── Nifty Futures 3-min timeline ─────────────────────────────────────────────
// Captures near-month Nifty futures: LTP, OI, Volume every 3 min (same dedup).
if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS futures_bars (
      iso_ts   TEXT NOT NULL PRIMARY KEY,
      bar_data JSONB NOT NULL
    )
  `).catch((e: Error) => console.error("[futures] table init:", e.message));
}

let futuresBars: any[] = [];
let futuresLoaded = false;

async function getFuturesAsync(): Promise<any[]> {
  if (!futuresLoaded) {
    if (pgPool) {
      try {
        const cutoff = new Date(Date.now() - MAX_HISTORY_MS).toISOString();
        const { rows } = await pgPool.query(
          `SELECT bar_data FROM futures_bars WHERE iso_ts >= $1 ORDER BY iso_ts DESC`,
          [cutoff]
        );
        futuresBars = pruneOld(rows.map((r: any) => r.bar_data));
      } catch (e: any) { console.error("[db] futures load:", e.message); }
    }
    futuresLoaded = true;
  }
  return futuresBars;
}

// Build the NSE_FO instrument key for near-month Nifty futures.
// Rolls to next month after the last Thursday (expiry) of the current month.
function getNiftyFuturesKeyFallback(): string {
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const now = new Date();
  // Last Thursday of current month
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const thursdayOffset = (lastOfMonth.getDay() + 3) % 7; // days back to get Thursday
  const lastThursday = new Date(now.getFullYear(), now.getMonth(), lastOfMonth.getDate() - thursdayOffset);
  const target = now > lastThursday
    ? new Date(now.getFullYear(), now.getMonth() + 1, 1) // roll to next month
    : now;
  const yy = target.getFullYear().toString().slice(-2);
  const mon = MONTHS[target.getMonth()];
  return `NSE_FO|NIFTY${yy}${mon}FUT`;
}

// Discover the real near-month Nifty futures instrument key from Upstox contracts.
// The /v2/option/contract endpoint returns both options and FUT contracts.
// Cache result for 4 hours to avoid repeated lookups.
let cachedFuturesKey = "";
let futuresKeyFetchedAt = 0;

async function getNiftyFuturesKey(token: string): Promise<string> {
  if (cachedFuturesKey && Date.now() - futuresKeyFetchedAt < 4 * 60 * 60 * 1000) {
    return cachedFuturesKey;
  }
  try {
    const res = await axios.get(
      "https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX|Nifty%2050",
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
    );
    const contracts: any[] = res.data?.data || [];
    console.log(`[futures] contracts fetched: ${contracts.length} total`);

    // Look for FUT type contracts (Nifty futures)
    const futures = contracts.filter((c: any) =>
      c.instrument_type === "FUT" ||
      c.instrument_key?.includes("FUT") ||
      c.option_type === "FUT"
    ).sort((a: any, b: any) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime());

    console.log(`[futures] FUT contracts found: ${futures.length}`, futures.slice(0, 3).map((f: any) => f.instrument_key));

    const now = new Date();
    const nearMonth = futures.find((c: any) => new Date(c.expiry) >= now);
    if (nearMonth?.instrument_key) {
      cachedFuturesKey = nearMonth.instrument_key;
      futuresKeyFetchedAt = Date.now();
      console.log("[futures] discovered key:", cachedFuturesKey, "expiry:", nearMonth.expiry);
      return cachedFuturesKey;
    }
  } catch (e: any) {
    console.error("[futures] key discovery failed:", e.message);
  }
  // Fall back to constructed key
  const fallback = getNiftyFuturesKeyFallback();
  console.log("[futures] using fallback key:", fallback);
  return fallback;
}

// Futures smart money: price direction × OI direction
function futuresReading(coiBar: number, ltpChange: number, isFirstBar: boolean): string {
  if (isFirstBar) return "Opening bar — watching for direction.";
  if (coiBar > 0 && ltpChange > 0) return "Long Build. Bullish — fresh longs being added.";
  if (coiBar > 0 && ltpChange < 0) return "Short Build. Bearish — fresh shorts being added.";
  if (coiBar < 0 && ltpChange > 0) return "Short Cover. Bullish — shorts unwinding.";
  if (coiBar < 0 && ltpChange < 0) return "Long Unwind. Bearish — longs exiting.";
  return "Neutral / Sideways.";
}

async function captureFutures(forceToken?: string): Promise<void> {
  const token = forceToken || activeToken;
  if (!token || token === "YOUR_UPSTOX_API_TOKEN") {
    console.log("[futures] skipped: no token");
    return;
  }
  if (!isMarketOpen()) {
    console.log("[futures] skipped: market closed");
    return;
  }
  try {
    const instrumentKey = await getNiftyFuturesKey(token);
    console.log("[futures] fetching quote for:", instrumentKey);
    const res = await axios.get(
      `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
    );
    console.log("[futures] raw response keys:", Object.keys(res.data?.data || {}));
    // Upstox returns data keyed by "NSE_FO:NIFTY26MARFUT" (pipe → colon)
    const quoteKey = instrumentKey.replace("|", ":");
    const d = res.data?.data?.[quoteKey] || res.data?.data?.[instrumentKey];
    if (!d) {
      console.warn("[futures] no data for key:", quoteKey, "| available keys:", Object.keys(res.data?.data || {}));
      return;
    }

    const history = await getFuturesAsync();
    const prevBar = history[0];
    const isFirstBar = !prevBar || isNewTradingDay(prevBar);

    const ltp    = parseFloat((d.last_price || 0).toFixed(2));
    const oi     = d.oi || 0;
    const volCum = d.volume || 0;

    const coiBar   = isFirstBar ? 0 : oi - (prevBar.rawOI || 0);
    const volDelta = isFirstBar ? volCum : Math.max(0, volCum - (prevBar.rawVol || 0));
    const ltpChange = isFirstBar ? 0 : parseFloat((ltp - (prevBar.ltp || 0)).toFixed(2));

    const now = new Date();
    // 150-second dedup — same as options timeline bars
    if (history.length > 0 && history[0].isoTimestamp) {
      if (Math.abs(now.getTime() - new Date(history[0].isoTimestamp).getTime()) < 150_000) return;
    }

    const point = {
      isoTimestamp: now.toISOString(),
      timestamp: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }),
      instrumentKey,
      ltp,
      ltpChange,
      oi,
      rawOI: oi,
      coiBar,
      volCum,
      rawVol: volCum,
      volDelta,
      reading: futuresReading(coiBar, ltpChange, isFirstBar),
    };

    futuresBars.unshift(point);
    futuresBars = pruneOld(futuresBars);

    if (pgPool) {
      pgPool.query(
        `INSERT INTO futures_bars (iso_ts, bar_data) VALUES ($1,$2)
         ON CONFLICT (iso_ts) DO UPDATE SET bar_data=EXCLUDED.bar_data`,
        [point.isoTimestamp, point]
      ).catch((e: Error) => console.error("[db] futures upsert:", e.message));
    }
    console.log(`[futures] bar captured: ltp=${ltp} oi=${oi} coiBar=${coiBar}`);
  } catch (e: any) {
    console.error(`[bg] captureFutures failed: ${extractApiError(e)}`);
  }
}

// ── Sensex 3-min bar storage ──────────────────────────────────────────────────
if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS sensex_bars (
      strike   INTEGER NOT NULL,
      iso_ts   TEXT    NOT NULL,
      bar_data JSONB   NOT NULL,
      PRIMARY KEY (strike, iso_ts)
    )
  `).catch((e: Error) => console.error("[sensex] sensex_bars init:", e.message));
}

const SENSEX_DATA_DIR = path.join(process.cwd(), "sensex-data");
if (!fs.existsSync(SENSEX_DATA_DIR)) fs.mkdirSync(SENSEX_DATA_DIR, { recursive: true });

const sensexStore = new Map<number, any[]>();

async function getSensexHistoryAsync(strike: number): Promise<any[]> {
  if (!sensexStore.has(strike)) {
    let rows: any[] = [];
    if (pgPool) {
      try {
        const cutoff = new Date(Date.now() - MAX_HISTORY_MS).toISOString();
        const { rows: dbRows } = await pgPool.query(
          `SELECT bar_data FROM sensex_bars WHERE strike=$1 AND iso_ts>=$2 ORDER BY iso_ts DESC`,
          [strike, cutoff]
        );
        rows = dbRows.map((r: any) => r.bar_data);
      } catch (e: any) { console.error("[sensex] db load:", e.message); }
    } else {
      try {
        const file = path.join(SENSEX_DATA_DIR, `sensex-${strike}.json`);
        if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {}
    }
    sensexStore.set(strike, pruneOld(rows));
  }
  return sensexStore.get(strike)!;
}

function getSensexHistory(strike: number): any[] {
  return sensexStore.get(strike) || [];
}

async function appendSensexHistory(strike: number, point: any): Promise<any[]> {
  const history = await getSensexHistoryAsync(strike);
  if (history.length > 0 && history[0].isoTimestamp) {
    const lastMs = new Date(history[0].isoTimestamp).getTime();
    const nowMs  = new Date(point.isoTimestamp).getTime();
    if (Math.abs(nowMs - lastMs) < 150_000) return history; // 2.5-min dedup
  }
  history.unshift(point);
  const pruned = pruneOld(history);
  sensexStore.set(strike, pruned);
  if (pgPool) {
    pgPool.query(
      `INSERT INTO sensex_bars (strike, iso_ts, bar_data) VALUES ($1,$2,$3)
       ON CONFLICT (strike, iso_ts) DO UPDATE SET bar_data=EXCLUDED.bar_data`,
      [strike, point.isoTimestamp, point]
    ).catch((e: Error) => console.error("[sensex] db upsert:", e.message));
  } else {
    try { fs.writeFileSync(path.join(SENSEX_DATA_DIR, `sensex-${strike}.json`), JSON.stringify(pruned)); } catch {}
  }
  return pruned;
}

// Sensex options expire on Thursdays (getDay()===4); holiday fallback → Wednesday (===3)
function pickSensexExpiries(sortedExpiries: string[]): string[] {
  const thursdays = sortedExpiries.filter(d => {
    const day = new Date(d).getDay();
    return day === 4 || day === 3;
  });
  return thursdays.length > 0 ? thursdays : sortedExpiries;
}

let cachedSensexExpiry = "";
let sensexExpiryFetchedAt = 0;

async function getSensexExpiry(token: string): Promise<string> {
  if (cachedSensexExpiry && Date.now() - sensexExpiryFetchedAt < 15 * 60 * 1000) return cachedSensexExpiry;
  const res = await axios.get(
    "https://api.upstox.com/v2/option/contract?instrument_key=BSE_INDEX|SENSEX",
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
  );
  const set = new Set<string>();
  (res.data?.data || []).forEach((c: any) => { if (c.expiry) set.add(c.expiry); });
  const sorted = Array.from(set).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const weekly = pickSensexExpiries(sorted);
  cachedSensexExpiry = weekly[0] || sorted[0] || "";
  sensexExpiryFetchedAt = Date.now();
  console.log(`[sensex-expiry] selected ${cachedSensexExpiry}`);
  return cachedSensexExpiry;
}

async function captureSensexStrikes(): Promise<void> {
  if (!isMarketOpen() || !activeToken || activeToken === "YOUR_UPSTOX_API_TOKEN") return;
  try {
    const expiry = await getSensexExpiry(activeToken);
    if (!expiry) return;
    const chainRes = await axios.get(
      `https://api.upstox.com/v2/option/chain?instrument_key=BSE_INDEX|SENSEX&expiry_date=${expiry}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${activeToken}` } }
    );
    const allStrikes: any[] = chainRes.data?.data || [];
    console.log(`[sensex-bg] capturing ${allStrikes.length} Sensex strikes for expiry ${expiry}`);
    for (const sd of allStrikes) {
      const strike: number = sd.strike_price;
      await getSensexHistoryAsync(strike);
      const prev = getSensexHistory(strike)[0];
      const point = buildPoint(sd, prev, SENSEX_LOT_SIZE);
      await appendSensexHistory(strike, point);
    }
  } catch (e: any) {
    console.error(`[sensex-bg] captureSensexStrikes failed: ${extractApiError(e)}`);
  }
}

// Start background capture — runs immediately then every 60 s during market hours.
// appendToHistory has a 150-second dedup so timeline bars are still ~3 min apart.
// appendLiveHistory has a 30-second dedup giving fresh 1-min live bars.
function startBackgroundCapture() {
  captureAllStrikes();     // run immediately on startup
  captureFutures();        // also capture futures immediately
  captureSensexStrikes();  // Sensex strikes
  setInterval(captureAllStrikes,    60 * 1000);
  setInterval(captureFutures,       60 * 1000);
  setInterval(captureSensexStrikes, 60 * 1000);
  console.log("[bg] background strike + futures + sensex capture scheduled every 60 s");
}
function pickWeeklyExpiries(sortedExpiries: string[]): string[] {
  // Nifty 50 weekly + monthly options expire on Tuesdays (getDay() === 2).
  // If Tuesday is a market holiday, expiry shifts to Monday (getDay() === 1).
  const tuesdayExpiries = sortedExpiries.filter(d => {
    const day = new Date(d).getDay();
    return day === 2 || day === 1; // Tuesday or holiday-shifted Monday
  });
  // Use Tuesday filter if ANY are found (>= 1), otherwise fall back to all
  return tuesdayExpiries.length > 0 ? tuesdayExpiries : sortedExpiries;
}

// ── Nitin Bhatia 4-State Smart Money Reading ─────────────────────────────────
// For each side: OI direction × Premium direction → position type
// Call side: Long Build=bullish, Writing=bearish, Short Cover=bullish, Long Unwind=bearish
// Put  side: Long Build=bearish, Writing=bullish, Short Cover=bearish, Long Unwind=bullish
function smartMoneyReading(
  callCOI: number, callPremRoc: number,
  putCOI: number,  putPremRoc: number,
  isFirstBar: boolean
): string {
  // First bar has no Premium ROC — use OI-only reading
  if (isFirstBar) {
    if (callCOI > 0 && putCOI > 0) return "Both sides building OI. Market consolidating.";
    if (callCOI > 0) return "Call OI building. Resistance forming at strike.";
    if (putCOI > 0) return "Put OI building. Support forming at strike.";
    return "OI neutral. Watch for directional cues.";
  }

  function positionState(coi: number, premRoc: number): string {
    if (coi > 0 && premRoc > 0) return "Long Build";
    if (coi > 0 && premRoc < 0) return "Writing";
    if (coi < 0 && premRoc > 0) return "Short Cover";
    if (coi < 0 && premRoc < 0) return "Long Unwind";
    return "Neutral";
  }

  const cs = positionState(callCOI, callPremRoc);
  const ps = positionState(putCOI, putPremRoc);

  // Bias: +1 = bullish signal, -1 = bearish signal, 0 = neutral
  const callBias: Record<string, number> = { "Long Build": 1, "Writing": -1, "Short Cover": 1, "Long Unwind": -1, "Neutral": 0 };
  const putBias:  Record<string, number> = { "Long Build": -1, "Writing": 1, "Short Cover": -1, "Long Unwind": 1, "Neutral": 0 };

  const total = (callBias[cs] ?? 0) + (putBias[ps] ?? 0);
  const sentiment =
    total >= 2  ? "Strongly Bullish" :
    total === 1 ? "Mildly Bullish"   :
    total === -1? "Mildly Bearish"   :
    total <= -2 ? "Strongly Bearish" : "Neutral / Consolidating";

  return `Call ${cs} | Put ${ps}. ${sentiment}.`;
}

// ── 3-min Index Chart: helpers + endpoint ────────────────────────────────────

function getISTDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}
function getISTMinutesFrom(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  return parseInt(parts.find(p => p.type === "hour")!.value) * 60
       + parseInt(parts.find(p => p.type === "minute")!.value);
}

// Snap ISO timestamp to 3-min bar start (ms). Returns -1 outside market hours.
function to3MinBarMs(isoTs: string): number {
  const d = new Date(isoTs);
  const istMin = getISTMinutesFrom(d);
  const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
  if (istMin < OPEN || istMin > CLOSE) return -1;
  const barIdx = Math.floor((istMin - OPEN) / 3);
  const sessionStart = new Date(`${getISTDateStr(d)}T09:15:00+05:30`).getTime();
  return sessionStart + barIdx * 3 * 60 * 1000;
}

interface Bar3 { time: number; open: number; high: number; low: number; close: number; volume: number; }

function aggregateTo3Min(candles: any[]): Bar3[] {
  // candles: [[isoTs, open, high, low, close, volume, oi], ...]
  const groups = new Map<number, any[]>();
  for (const c of candles) {
    const barMs = to3MinBarMs(c[0] as string);
    if (barMs < 0) continue;
    if (!groups.has(barMs)) groups.set(barMs, []);
    groups.get(barMs)!.push(c);
  }
  const bars: Bar3[] = [];
  for (const [barMs, cs] of groups) {
    cs.sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    bars.push({
      time: barMs,
      open:   cs[0][1],
      high:   Math.max(...cs.map((x: any) => x[2])),
      low:    Math.min(...cs.map((x: any) => x[3])),
      close:  cs[cs.length - 1][4],
      volume: cs.reduce((s: number, x: any) => s + (x[5] || 0), 0),
    });
  }
  return bars.sort((a, b) => a.time - b.time);
}
function getISTNowParts() {
  const now = new Date();

  const date = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });

  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const second = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);

  return { date, hour, minute, second };
}

function computeVwap(bars: Bar3[]): { time: number; value: number }[] {
  let cumPV = 0, cumV = 0, prevDate = "";
  return bars.map(b => {
    const date = getISTDateStr(new Date(b.time));
    if (date !== prevDate) { cumPV = 0; cumV = 0; prevDate = date; }
    const tp = (b.high + b.low + b.close) / 3;
    const v  = b.volume > 0 ? b.volume : 1; // fallback so VWAP = TWAP for index without vol
    cumPV += tp * v; cumV += v;
    return { time: b.time, value: Math.round(cumPV / cumV * 100) / 100 };
  });
}
// ── Manual export helpers ──────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value: any): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function barsForISTDate(bars: any[], dateStr: string): any[] {
  return bars
    .filter((b) => b?.isoTimestamp && getISTDateStr(new Date(b.isoTimestamp)) === dateStr)
    .slice()
    .sort((a, b) => new Date(a.isoTimestamp).getTime() - new Date(b.isoTimestamp).getTime());
}

function timelineBarsToCsv(rows: any[]): string {
  const headers = [
    "isoTimestamp", "timestamp", "spot",
    "call_oi", "call_coi", "call_volDelta", "call_coiVolRatio", "call_tqNtRatio",
    "call_iv", "call_ivRoc", "call_ltp", "call_premiumRoc",
    "put_premiumRoc", "put_ltp", "put_ivRoc", "put_iv",
    "put_tqNtRatio", "put_coiVolRatio", "put_volDelta", "put_coi", "put_oi",
    "reading",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = [
      row.isoTimestamp, row.timestamp, row.spot,
      row.call?.oi, row.call?.coi, row.call?.volDelta, row.call?.coiVolRatio, row.call?.tqNtRatio,
      row.call?.iv, row.call?.ivRoc, row.call?.ltp, row.call?.premiumRoc,
      row.put?.premiumRoc, row.put?.ltp, row.put?.ivRoc, row.put?.iv,
      row.put?.tqNtRatio, row.put?.coiVolRatio, row.put?.volDelta, row.put?.coi, row.put?.oi,
      row.reading,
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

async function getOpeningNiftySpot(token: string, dateStr: string): Promise<number | null> {
  try {
    const instrKey = encodeURIComponent("NSE_INDEX|Nifty 50");
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${instrKey}/1minute`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });
    const candles: any[] = resp.data?.data?.candles || [];
    const todays = candles.filter((c) => {
      const ts = c?.[0];
      if (!ts) return false;
      return getISTDateStr(new Date(ts)) === dateStr;
    });
    if (todays.length === 0) return null;
    todays.sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    const open = Number(todays[0]?.[1] || 0);
    return open > 0 ? open : null;
  } catch (e: any) {
    console.error("[export] opening nifty spot fetch failed:", e.message);
    return null;
  }
}

function buildStrikeRangeFromOpeningSpot(openingSpot: number): number[] {
  const atm = Math.round(openingSpot / 50) * 50;
  const strikes: number[] = [];
  for (let s = atm - 500; s <= atm + 500; s += 50) strikes.push(s);
  return strikes;
}



function normalizeUrl(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function resolvePublicOrigin(req: Request): string {
  const appUrl = normalizeUrl(process.env.APP_URL);
  if (appUrl) return appUrl;

  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = req.get("host");
  const protocol = req.protocol || (req.secure ? "https" : "http");
  return `${protocol}://${host}`;
}


function resolveUpstoxRedirectUri(req: Request): string {
  const explicitRedirect = normalizeUrl(process.env.UPSTOX_REDIRECT_URI);
  if (explicitRedirect) return explicitRedirect;
  return `${resolvePublicOrigin(req)}/api/auth/upstox/callback`;
}









// Cross-strike volume spurt detection
// Nifty:  table=timeline_bars, step=50,  half=500  → ATM±500 (21 strikes)
// Sensex: table=sensex_bars,   step=500, half=2000 → ATM±2000 (9 strikes)
interface SpurtDetail { time: number; strikes: number[]; }

async function detectSpurts(
  spot: number,
  table: "timeline_bars" | "sensex_bars",
  step: number,
  half: number,
  cutoffIso: string
): Promise<SpurtDetail[]> {
  if (!pgPool || spot <= 0) return [];
  try {
    const atm = Math.round(spot / step) * step;
    const lo = atm - half, hi = atm + half;
    const strikes = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

    const { rows } = await pgPool.query(
      `SELECT strike, iso_ts,
              COALESCE((bar_data->'call'->>'volDelta')::float, 0) +
              COALESCE((bar_data->'put'->>'volDelta')::float, 0) AS vol
       FROM ${table}
       WHERE strike = ANY($1) AND iso_ts >= $2
       ORDER BY iso_ts`,
      [strikes, cutoffIso]
    );

    // Snap each row to a 3-min bar bucket
    const byBar = new Map<number, Map<number, number>>();
    for (const r of rows) {
      const bar = to3MinBarMs(r.iso_ts as string);
      if (bar < 0) continue;
      if (!byBar.has(bar)) byBar.set(bar, new Map());
      byBar.get(bar)!.set(r.strike as number, r.vol as number);
    }

    // Per-strike rolling history (last 20 bars) → z-score threshold
    // A "synchronized spurt" requires ALL ATM±half strikes to fire together.
    // Thresholds:
    //   • MIN_HIST_BARS = 10  — need at least 10 bars before evaluating
    //   • Z_THRESH = 2.5      — vol must exceed mean + 2.5 × std
    //   • MIN_COVERAGE = 0.95 — ≥95% of strikes must have data in this bar
    //   • MIN_SPURT_FRAC = 0.90 — ≥90% of present strikes must be spiking
    const history = new Map<number, number[]>();
    const spurts: SpurtDetail[] = [];
    const Z_THRESH = 2.5, MIN_HIST_BARS = 10, MIN_COVERAGE = 0.95, MIN_SPURT_FRAC = 0.90;

    for (const [bar, strikeVols] of [...byBar.entries()].sort((a, b) => a[0] - b[0])) {
      const spurtStrikes: number[] = [];
      let covered = 0;

      for (const [strike, vol] of strikeVols) {
        const hist = history.get(strike) || [];

        if (hist.length >= MIN_HIST_BARS) {
          const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
          const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length;
          const std = Math.sqrt(variance);
          // Use at least 10% of the mean as a floor for std so low-volume
          // strikes with near-zero variance don't fire on tiny absolute moves.
          const effectiveStd = Math.max(std, mean * 0.10);
          if (effectiveStd > 0 && vol > mean + Z_THRESH * effectiveStd) {
            spurtStrikes.push(strike);
          }
        }

        covered++;
        history.set(strike, [...hist, vol].slice(-20));
      }

      // Only emit a spurt when nearly all ATM±half strikes spike together
      const coverageFrac = covered / strikes.length;
      const spurtFrac    = covered > 0 ? spurtStrikes.length / covered : 0;
      if (coverageFrac >= MIN_COVERAGE && spurtFrac >= MIN_SPURT_FRAC) {
        spurts.push({ time: bar, strikes: spurtStrikes.sort((a, b) => a - b) });
      }
    }
    return spurts;
  } catch (e: any) {
    console.error(`[spurts:${table}]`, e.message);
    return [];
  }
}


  // API routes


// ── Historical OI store (module-level — used by export helpers below) ────────
const HIST_OI_FILE = path.join(process.cwd(), "data", "historical-oi.json");

interface DailyOISnapshot {
  date: string; // YYYY-MM-DD
  niftyClose: number | null;
  participants: Array<{
    name: string;
    idxFutLong: number; idxFutShort: number;
    callLong: number;   callShort: number;
    putLong: number;    putShort: number;
    stkFutLong: number; stkFutShort: number;
  }>;
}

function loadHistoricalOI(): DailyOISnapshot[] {
  try { return JSON.parse(fs.readFileSync(HIST_OI_FILE, "utf-8")); } catch { return []; }
}

function saveHistoricalOI(data: DailyOISnapshot[]) {
  try {
    fs.mkdirSync(path.dirname(HIST_OI_FILE), { recursive: true });
    fs.writeFileSync(HIST_OI_FILE, JSON.stringify(data));
  } catch (e: any) { console.error("[hist-oi] save failed:", e.message); }
}

// ── OC Snapshot store (module-level — used by resolveOpeningNiftySpot) ───────
const OC_SNAPSHOT_FILE = path.join(process.cwd(), "data", "oc-snapshots.json");
const OC_MAX_DAYS = 7; // Retain only 7 days of EOD snapshots

interface OcSnapshotEntry {
  date: string;
  takenAt: string;
  niftySpot: number;
  niftyStrikes: Array<{
    strike: number;
    callOI: number; callCOI: number; callLTP: number;
    putOI: number;  putCOI: number;  putLTP: number;
  }>;
}

function loadOcSnapshots(): OcSnapshotEntry[] {
  try { return JSON.parse(fs.readFileSync(OC_SNAPSHOT_FILE, "utf-8")); } catch { return []; }
}

function saveOcSnapshots(data: OcSnapshotEntry[]) {
  try {
    fs.mkdirSync(path.dirname(OC_SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(OC_SNAPSHOT_FILE, JSON.stringify(data));
  } catch (e: any) { console.error("[oc-snap] save failed:", e.message); }
}

// ── Manual Export types ───────────────────────────────────────────────────────
type ManualExportMeta = {
  ok: boolean;
  date: string;
  openingSpot: number | null;
  strikeCount: number;
  writtenCount: number;
  reason?: string;
  files?: string[];
};

const MANUAL_EXPORTS_DIR = path.join(process.cwd(), "manual-exports");
const MANUAL_EXPORT_META_FILE = path.join(process.cwd(), "data", "manual-export-last.json");

if (!fs.existsSync(MANUAL_EXPORTS_DIR)) fs.mkdirSync(MANUAL_EXPORTS_DIR, { recursive: true });

function saveManualExportMeta(meta: ManualExportMeta) {
  try {
    fs.mkdirSync(path.dirname(MANUAL_EXPORT_META_FILE), { recursive: true });
    fs.writeFileSync(MANUAL_EXPORT_META_FILE, JSON.stringify(meta, null, 2), "utf-8");
  } catch (e: any) {
    console.error("[manual-export] save meta failed:", e.message);
  }
}

function loadManualExportMeta(): ManualExportMeta | null {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_EXPORT_META_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function getManualExportFolder(dateStr: string) {
  return path.join(MANUAL_EXPORTS_DIR, dateStr);
}

function getManualExportZip(dateStr: string) {
  return path.join(MANUAL_EXPORTS_DIR, `${dateStr}.zip`);
}

function computeThresholds(rows: any[]) {
  const abs = (n: number) => Math.abs(n);
  const p75 = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = values.map(abs).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  };

  return {
    coi: p75(rows.flatMap((r) => [Number(r.call?.coi || 0), Number(r.put?.coi || 0)])),
    coiVol: p75(rows.flatMap((r) => [parseFloat(r.call?.coiVolRatio || "0"), parseFloat(r.put?.coiVolRatio || "0")])),
    tq: p75(rows.flatMap((r) => [parseFloat(r.call?.tqNtRatio || "0"), parseFloat(r.put?.tqNtRatio || "0")])),
    ivRoc: p75(rows.flatMap((r) => [parseFloat(r.call?.ivRoc || "0"), parseFloat(r.put?.ivRoc || "0")])),
    premRoc: p75(rows.flatMap((r) => [parseFloat(r.call?.premiumRoc || "0"), parseFloat(r.put?.premiumRoc || "0")])),
  };
}

function isUnusual(value: number, threshold: number) {
  return threshold > 0 && Math.abs(value) > threshold;
}

async function writeStrikeWorkbook(filePath: string, strike: number, rows: any[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`NIFTY_${strike}`);

  const thresholds = computeThresholds(rows);

  ws.columns = [
    { header: "timestamp", key: "timestamp", width: 16 },
    { header: "spot", key: "spot", width: 12 },

    { header: "call_oi", key: "call_oi", width: 12 },
    { header: "call_coi", key: "call_coi", width: 12 },
    { header: "call_vol_delta", key: "call_vol_delta", width: 14 },
    { header: "call_coi_vol", key: "call_coi_vol", width: 12 },
    { header: "call_tq_nt", key: "call_tq_nt", width: 12 },
    { header: "call_iv", key: "call_iv", width: 10 },
    { header: "call_iv_roc", key: "call_iv_roc", width: 12 },
    { header: "call_ltp", key: "call_ltp", width: 10 },
    { header: "call_premium_roc", key: "call_premium_roc", width: 16 },

    { header: "put_premium_roc", key: "put_premium_roc", width: 16 },
    { header: "put_ltp", key: "put_ltp", width: 10 },
    { header: "put_iv_roc", key: "put_iv_roc", width: 12 },
    { header: "put_iv", key: "put_iv", width: 10 },
    { header: "put_tq_nt", key: "put_tq_nt", width: 12 },
    { header: "put_coi_vol", key: "put_coi_vol", width: 12 },
    { header: "put_vol_delta", key: "put_vol_delta", width: 14 },
    { header: "put_coi", key: "put_coi", width: 12 },
    { header: "put_oi", key: "put_oi", width: 12 },

    { header: "signal", key: "signal", width: 22 },
    { header: "reading", key: "reading", width: 40 },

    { header: "call_unusual", key: "call_unusual", width: 14 },
    { header: "put_unusual", key: "put_unusual", width: 14 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEFEF" },
  };

  for (const r of rows) {
    const callCoi = Number(r.call?.coi || 0);
    const putCoi = Number(r.put?.coi || 0);
    const callCoiVol = parseFloat(r.call?.coiVolRatio || "0");
    const putCoiVol = parseFloat(r.put?.coiVolRatio || "0");
    const callTq = parseFloat(r.call?.tqNtRatio || "0");
    const putTq = parseFloat(r.put?.tqNtRatio || "0");
    const callIvRoc = parseFloat(r.call?.ivRoc || "0");
    const putIvRoc = parseFloat(r.put?.ivRoc || "0");
    const callPremRoc = parseFloat(r.call?.premiumRoc || "0");
    const putPremRoc = parseFloat(r.put?.premiumRoc || "0");

    const callUnusual =
      isUnusual(callCoi, thresholds.coi) ||
      isUnusual(callCoiVol, thresholds.coiVol) ||
      isUnusual(callTq, thresholds.tq) ||
      isUnusual(callIvRoc, thresholds.ivRoc) ||
      isUnusual(callPremRoc, thresholds.premRoc);

    const putUnusual =
      isUnusual(putCoi, thresholds.coi) ||
      isUnusual(putCoiVol, thresholds.coiVol) ||
      isUnusual(putTq, thresholds.tq) ||
      isUnusual(putIvRoc, thresholds.ivRoc) ||
      isUnusual(putPremRoc, thresholds.premRoc);

    const signal =
      callUnusual && putUnusual
        ? "BOTH_UNUSUAL"
        : callUnusual
        ? "CALL_UNUSUAL"
        : putUnusual
        ? "PUT_UNUSUAL"
        : "";

    ws.addRow({
      timestamp: r.timestamp,
      spot: Number(r.spot),

      call_oi: Number(r.call?.oi || 0),
      call_coi: callCoi,
      call_vol_delta: Number(r.call?.volDelta || 0),
      call_coi_vol: callCoiVol,
      call_tq_nt: Number(r.call?.tqNtRatio || 0),
      call_iv: Number(r.call?.iv || 0),
      call_iv_roc: callIvRoc,
      call_ltp: Number(r.call?.ltp || 0),
      call_premium_roc: callPremRoc,

      put_premium_roc: putPremRoc,
      put_ltp: Number(r.put?.ltp || 0),
      put_iv_roc: putIvRoc,
      put_iv: Number(r.put?.iv || 0),
      put_tq_nt: Number(r.put?.tqNtRatio || 0),
      put_coi_vol: putCoiVol,
      put_vol_delta: Number(r.put?.volDelta || 0),
      put_coi: putCoi,
      put_oi: Number(r.put?.oi || 0),

      signal,
      reading: r.reading || "",
      call_unusual: callUnusual ? "YES" : "",
      put_unusual: putUnusual ? "YES" : "",
    });
  }

  const yellow = {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FFFFF59D" },
  };

  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const callUnusual = row.getCell("call_unusual").value === "YES";
    const putUnusual = row.getCell("put_unusual").value === "YES";

    if (callUnusual) {
      ["D", "E", "F", "G", "I", "K", "X"].forEach((col) => {
        row.getCell(col).fill = yellow;
      });
    }

    if (putUnusual) {
      ["L", "N", "P", "Q", "R", "S", "Y"].forEach((col) => {
        row.getCell(col).fill = yellow;
      });
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];
  await wb.xlsx.writeFile(filePath);
}

async function writeEodParticipantsWorkbook(filePath: string, dateStr: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("EOD_PARTICIPANTS_RAW");

  const hist = loadHistoricalOI();
  const snap = hist.find((h) => h.date === dateStr);

  ws.columns = [
    { header: "date", key: "date", width: 14 },
    { header: "participant", key: "participant", width: 16 },
    { header: "idxFutLong", key: "idxFutLong", width: 14 },
    { header: "idxFutShort", key: "idxFutShort", width: 14 },
    { header: "callLong", key: "callLong", width: 12 },
    { header: "callShort", key: "callShort", width: 12 },
    { header: "putLong", key: "putLong", width: 12 },
    { header: "putShort", key: "putShort", width: 12 },
    { header: "stkFutLong", key: "stkFutLong", width: 14 },
    { header: "stkFutShort", key: "stkFutShort", width: 14 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFEFEF" },
  };

  if (snap?.participants?.length) {
    for (const p of snap.participants) {
      ws.addRow({
        date: dateStr,
        participant: p.name,
        idxFutLong: p.idxFutLong,
        idxFutShort: p.idxFutShort,
        callLong: p.callLong,
        callShort: p.callShort,
        putLong: p.putLong,
        putShort: p.putShort,
        stkFutLong: p.stkFutLong,
        stkFutShort: p.stkFutShort,
      });
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];
  await wb.xlsx.writeFile(filePath);
}

async function writeEodParticipantsCsv(filePath: string, dateStr: string) {
  const hist = loadHistoricalOI();
  const snap = hist.find((h) => h.date === dateStr);

  const headers = [
    "date",
    "participant",
    "idxFutLong",
    "idxFutShort",
    "callLong",
    "callShort",
    "putLong",
    "putShort",
    "stkFutLong",
    "stkFutShort",
  ];

  const lines = [headers.join(",")];

  if (snap?.participants?.length) {
    for (const p of snap.participants) {
      lines.push(
        [
          dateStr,
          p.name,
          p.idxFutLong,
          p.idxFutShort,
          p.callLong,
          p.callShort,
          p.putLong,
          p.putShort,
          p.stkFutLong,
          p.stkFutShort,
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

async function createZipFromFolder(folderPath: string, zipPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(folderPath, path.basename(folderPath));
    archive.finalize();
  });
}

// Returns true if an ISO timestamp falls in the 9:15–9:30 AM IST window
// (UTC equivalent: 03:45–04:00 on the same calendar date)
function isIn920Window(isoTimestamp: string): boolean {
  const utcMs = new Date(isoTimestamp).getTime();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  const istMs = utcMs + istOffsetMs;
  const istDate = new Date(istMs);
  const istHour = istDate.getUTCHours();
  const istMin  = istDate.getUTCMinutes();
  const totalMin = istHour * 60 + istMin;
  return totalMin >= 9 * 60 + 15 && totalMin <= 9 * 60 + 30; // 9:15–9:30 AM IST
}

async function getOpeningNiftySpotFromStoredData(dateStr: string): Promise<number | null> {
  try {
    // ── 1. In-memory timeline store: prefer bar in 9:15–9:30 IST window ──────
    let windowBar: any = null;
    let earliestBar: any = null;

    for (const [, bars] of timelineStore.entries()) {
      const dayBars = barsForISTDate(bars, dateStr);
      if (dayBars.length === 0) continue;
      // dayBars is sorted ascending by time
      for (const bar of dayBars) {
        if (isIn920Window(bar.isoTimestamp) && bar?.spot && parseFloat(bar.spot) > 0) {
          if (!windowBar || new Date(bar.isoTimestamp).getTime() < new Date(windowBar.isoTimestamp).getTime()) {
            windowBar = bar;
          }
          break; // first match per strike is fine
        }
      }
      const first = dayBars[0];
      if (!earliestBar || new Date(first.isoTimestamp).getTime() < new Date(earliestBar.isoTimestamp).getTime()) {
        earliestBar = first;
      }
    }

    const bestMemBar = windowBar || earliestBar;
    if (bestMemBar?.spot) {
      const spot = parseFloat(bestMemBar.spot);
      if (spot > 0) return spot;
    }

    // ── 2. DB: look for the 9:15–9:30 AM IST window first (3:45–4:00 UTC) ──
    if (pgPool) {
      const windowStart = `${dateStr}T03:45:00.000Z`;
      const windowEnd   = `${dateStr}T04:00:00.000Z`;

      const { rows: winRows } = await pgPool.query(
        `SELECT bar_data
         FROM timeline_bars
         WHERE iso_ts >= $1 AND iso_ts <= $2
           AND (bar_data->>'spot') IS NOT NULL
           AND (bar_data->>'spot')::numeric > 0
         ORDER BY iso_ts ASC
         LIMIT 1`,
        [windowStart, windowEnd]
      );

      const winBar = winRows?.[0]?.bar_data;
      if (winBar?.spot) {
        const spot = parseFloat(winBar.spot);
        if (spot > 0) {
          console.log(`[manual-export] opening spot resolved from 9:20 window bar: ${spot}`);
          return spot;
        }
      }

      // ── 3. DB: fall back to any bar on the full trading day ────────────────
      const dayStart = `${dateStr}T00:00:00.000Z`;
      const end = new Date(`${dateStr}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      const dayEnd = end.toISOString();

      const { rows } = await pgPool.query(
        `SELECT bar_data
         FROM timeline_bars
         WHERE iso_ts >= $1 AND iso_ts < $2
         ORDER BY iso_ts ASC
         LIMIT 1`,
        [dayStart, dayEnd]
      );

      const firstBar = rows?.[0]?.bar_data;
      if (firstBar?.spot) {
        const spot = parseFloat(firstBar.spot);
        if (spot > 0) return spot;
      }
    }

    // ── 4. OC snapshot fallback ──────────────────────────────────────────────
    const snaps = loadOcSnapshots();
    const sameDay = snaps.find((s) => s.date === dateStr);
    if (sameDay?.niftySpot && sameDay.niftySpot > 0) {
      return sameDay.niftySpot;
    }

    return null;
  } catch (e: any) {
    console.error("[manual-export] opening spot fallback failed:", e.message);
    return null;
  }
}

async function resolveOpeningNiftySpot(dateStr: string): Promise<number | null> {
  return await getOpeningNiftySpotFromStoredData(dateStr);
}


async function buildManualExportZip(dateStr?: string): Promise<{ zipPath: string; meta: ManualExportMeta }> {
  const date = dateStr || getISTDateStr(new Date());
  const openingSpot = await resolveOpeningNiftySpot(date);

  if (!openingSpot) {
    const meta = {
      ok: false,
      date,
      openingSpot: null,
      strikeCount: 0,
      writtenCount: 0,
      reason: "opening spot not available",
    };
    saveManualExportMeta(meta);
    throw new Error(meta.reason);
  }

  const strikes = buildStrikeRangeFromOpeningSpot(openingSpot);
  const folderPath = getManualExportFolder(date);
  const zipPath = getManualExportZip(date);

  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  ensureDir(folderPath);

  const files: string[] = [];
  let writtenCount = 0;

  for (const strike of strikes) {
    const bars = await getHistoryAsync(strike);
    const dayBars = barsForISTDate(bars, date);
    if (dayBars.length === 0) continue;

    const fileName = `NIFTY_${strike}.xlsx`;
    const filePath = path.join(folderPath, fileName);
    await writeStrikeWorkbook(filePath, strike, dayBars);
    files.push(fileName);
    writtenCount++;
  }

  const eodXlsx = `EOD_PARTICIPANTS_RAW_${date}.xlsx`;
  const eodCsv = `EOD_PARTICIPANTS_RAW_${date}.csv`;

  await writeEodParticipantsWorkbook(path.join(folderPath, eodXlsx), date);
  await writeEodParticipantsCsv(path.join(folderPath, eodCsv), date);
  files.push(eodXlsx, eodCsv);

  if (writtenCount === 0) {
    const meta = {
      ok: false,
      date,
      openingSpot,
      strikeCount: strikes.length,
      writtenCount: 0,
      reason: "no timeline bars found for selected strike range",
      files,
    };
    saveManualExportMeta(meta);
    throw new Error(meta.reason);
  }

  await createZipFromFolder(folderPath, zipPath);

  const meta: ManualExportMeta = {
    ok: true,
    date,
    openingSpot,
    strikeCount: strikes.length,
    writtenCount: files.length,
    files,
  };

  saveManualExportMeta(meta);
  return { zipPath, meta };
}

// ── Upstox auto-login scheduling ────────────────────────────────────────────
// Upstox access tokens expire daily. We run a headless-browser login every
// morning at 09:00 IST (before market open at 09:15) so the background
// poller always has a fresh token. The credentials live in env vars:
//   UPSTOX_CLIENT_ID          — OAuth app API key (UUID)
//   UPSTOX_CLIENT_SECRET      — OAuth app secret
//   UPSTOX_LOGIN_USER_ID      — 6-digit trading client ID
//   UPSTOX_LOGIN_PIN          — 6-digit PIN
//   UPSTOX_LOGIN_TOTP_SECRET  — base32 TOTP seed
//   UPSTOX_AUTO_LOGIN_REDIRECT — optional; defaults to the existing OAuth
//                                callback URL registered for the API key.

const DEFAULT_AUTO_LOGIN_REDIRECT =
  "https://basic-oc-mar2026-production.up.railway.app/api/auth/upstox/callback";

function resolveAutoLoginRedirect(): string {
  return (
    (process.env.UPSTOX_AUTO_LOGIN_REDIRECT || "").trim() ||
    (process.env.UPSTOX_REDIRECT_URI || "").trim() ||
    DEFAULT_AUTO_LOGIN_REDIRECT
  );
}

function autoLoginConfigured(): boolean {
  return !!(
    process.env.UPSTOX_CLIENT_ID &&
    process.env.UPSTOX_CLIENT_SECRET &&
    process.env.UPSTOX_LOGIN_USER_ID &&
    process.env.UPSTOX_LOGIN_PIN &&
    process.env.UPSTOX_LOGIN_TOTP_SECRET
  );
}

/**
 * Run the full headless auto-login and persist the resulting token via
 * the existing setConfiguredUpstoxToken() path, which also refreshes
 * `activeToken` so the background capture picks it up on the next tick.
 */
async function runUpstoxAutoLoginAndStore(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!autoLoginConfigured()) {
    const msg =
      "Auto-login not configured — set UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET, UPSTOX_LOGIN_USER_ID, UPSTOX_LOGIN_PIN, UPSTOX_LOGIN_TOTP_SECRET.";
    console.warn(`[upstox-auto-login] ${msg}`);
    return { ok: false, error: msg };
  }
  try {
    const redirectUri = resolveAutoLoginRedirect();
    console.log(`[upstox-auto-login] starting (redirect=${redirectUri})`);
    const { accessToken } = await upstoxAutoLogin({
      apiKey: process.env.UPSTOX_CLIENT_ID!,
      apiSecret: process.env.UPSTOX_CLIENT_SECRET!,
      loginUserId: process.env.UPSTOX_LOGIN_USER_ID!,
      loginPin: process.env.UPSTOX_LOGIN_PIN!,
      totpSecret: process.env.UPSTOX_LOGIN_TOTP_SECRET!,
      redirectUri,
    });
    await setConfiguredUpstoxToken(accessToken);
    console.log("[upstox-auto-login] success — access token stored and activeToken refreshed.");
    return { ok: true };
  } catch (e: any) {
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e);
    console.error("[upstox-auto-login] FAILED:", msg);
    return { ok: false, error: msg };
  }
}

/** Milliseconds until the next 09:00 IST instant. */
function msUntilNext9amIst(): number {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const istNow = new Date(nowMs + IST_OFFSET_MS);
  // Build today's 09:00 IST as a UTC ms timestamp.
  const todayNineIstUtcMs =
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate(),
      9, 0, 0, 0
    ) - IST_OFFSET_MS;
  if (todayNineIstUtcMs > nowMs) return todayNineIstUtcMs - nowMs;
  return todayNineIstUtcMs + 24 * 60 * 60 * 1000 - nowMs;
}

let autoLoginTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDailyTokenRefresh() {
  if (autoLoginTimer) clearTimeout(autoLoginTimer);
  const delay = msUntilNext9amIst();
  const wakeAt = new Date(Date.now() + delay);
  console.log(
    `[upstox-auto-login] next daily refresh scheduled for ${wakeAt.toISOString()} (in ${Math.round(delay / 1000 / 60)} min)`
  );
  autoLoginTimer = setTimeout(async () => {
    try {
      // Retry up to 3 times with 2-minute gaps on failure — transient
      // network/UI hiccups shouldn't lose us the whole day's data.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await runUpstoxAutoLoginAndStore();
        if (result.ok) break;
        if (attempt < 3) {
          console.warn(`[upstox-auto-login] retrying in 2 min (attempt ${attempt + 1}/3)…`);
          await new Promise((r) => setTimeout(r, 2 * 60 * 1000));
        }
      }
    } finally {
      // Always re-arm for tomorrow, even if today failed.
      scheduleDailyTokenRefresh();
    }
  }, delay);
}

async function startServer() {
  // Load the persisted Upstox token from DB/disk BEFORE starting the background poller.
  // Without this, a server restart would lose the token and stop all data capture.
  await bootstrapSecretState();
  activeToken = getConfiguredUpstoxToken();
  if (activeToken && activeToken !== "YOUR_UPSTOX_API_TOKEN") {
    console.log("[startup] Upstox token loaded from persistent store — background capture will run.");
  } else {
    console.warn("[startup] No Upstox token found — background capture will be skipped until a token is configured.");
  }

  // Schedule the daily 09:00 IST token refresh. This runs regardless of
  // startup token state so tomorrow's capture is always ready.
  if (autoLoginConfigured()) {
    scheduleDailyTokenRefresh();
    // If we booted without a valid token, kick off an immediate auto-login
    // in the background so data capture comes up on its own after a restart.
    if (!activeToken || activeToken === "YOUR_UPSTOX_API_TOKEN") {
      console.log("[startup] Kicking off immediate Upstox auto-login (no token loaded)…");
      runUpstoxAutoLoginAndStore().catch((e) =>
        console.error("[startup] initial auto-login failed:", e?.message || e)
      );
    }
  } else {
    console.warn(
      "[startup] Upstox auto-login credentials not fully configured — daily token refresh disabled."
    );
  }

  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(express.json());
  app.use(cookieParser());
  
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/capture-health", (_req, res) => {
    const now = Date.now();
    const staleSec = lastCaptureSuccessAt ? Math.floor((now - lastCaptureSuccessAt) / 1000) : null;
    res.json({
      hasToken:          !!activeToken && activeToken !== "YOUR_UPSTOX_API_TOKEN",
      lastSuccessAt:     lastCaptureSuccessAt,
      secondsSinceCapture: staleSec,
      stale:             staleSec !== null ? staleSec > 5 * 60 : true, // stale if >5 min or never succeeded
      lastError:         lastCaptureError,
      lastErrorAt:       lastCaptureErrorAt,
    });
  });

  app.get("/api/admin/status", (req, res) => {
    res.json({
      configured: adminConfigured(),
      authenticated: isAdminAuthenticated(req),
    });
  });

  app.post("/api/admin/login", (req, res) => {
    if (!adminConfigured()) {
      return res.status(503).json({ error: "ADMIN_PASSWORD is not configured." });
    }
    const provided = typeof req.body?.password === "string" ? req.body.password : "";
    if (!provided || !timingSafeEqualString(provided, adminPassword())) {
      return res.status(401).json({ error: "Invalid admin password." });
    }
    issueAdminSession(res);
    res.json({ success: true });
  });

  app.post("/api/admin/logout", (_req, res) => {
    clearAdminSession(res);
    res.json({ success: true });
  });

  // Auth status check
  app.get("/api/auth/status", (_req, res) => {
    res.json({ authenticated: hasConfiguredUpstoxToken() });
  });

  // Direct token submission (paste token flow)
  app.post("/api/auth/token", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { token } = req.body;
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      return res.status(400).json({ error: "Token is required" });
    }
    await setConfiguredUpstoxToken(token);
    res.json({ success: true });
  });

  // Logout / clear token
  app.post("/api/auth/logout", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await clearConfiguredUpstoxToken();
    res.json({ success: true });
  });

  // Manual trigger for the headless Upstox auto-login flow. Useful to verify
  // the end-to-end flow works before waiting for the 09:00 IST cron tick, or
  // to recover immediately after a token failure.
  app.post("/api/auth/upstox/auto-login", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!autoLoginConfigured()) {
      return res.status(400).json({
        error:
          "Auto-login not configured. Set UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET, UPSTOX_LOGIN_USER_ID, UPSTOX_LOGIN_PIN, UPSTOX_LOGIN_TOTP_SECRET.",
      });
    }
    const result = await runUpstoxAutoLoginAndStore();
    if (result.ok === true) {
      return res.json({ ok: true, message: "Upstox auto-login succeeded; token refreshed." });
    }
    return res.status(500).json({ ok: false, error: result.error });
  });

  // Upstox OAuth Routes
  app.get("/api/auth/upstox/url", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const clientId = process.env.UPSTOX_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: "UPSTOX_CLIENT_ID is not configured in environment variables." });
    }

    const redirectUri = resolveUpstoxRedirectUri(req);
    const state = issueOauthState(res, UPSTOX_OAUTH_STATE_COOKIE);
    const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
    res.json({ url: authUrl, redirectUri });
  });

  app.get(["/api/auth/upstox/callback", "/api/auth/upstox/callback/"], async (req, res) => {
    const { code, state } = req.query;
    if (!isAdminAuthenticated(req)) {
      return res.status(401).send("Admin authentication required.");
    }
    if (!consumeOauthState(req, res, UPSTOX_OAUTH_STATE_COOKIE, typeof state === "string" ? state : undefined)) {
      return res.status(400).send("Invalid Upstox OAuth state.");
    }

    const redirectUri = resolveUpstoxRedirectUri(req);
    const clientId = process.env.UPSTOX_CLIENT_ID;
    const clientSecret = process.env.UPSTOX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).send("Upstox Client ID or Secret is missing.");
    }

    try {
      const tokenRes = await axios.post(
        "https://api.upstox.com/v2/login/authorization/token",
        new URLSearchParams({
          code: code as string,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "Api-Version": "2.0",
          },
        }
      );

      const token = tokenRes.data.access_token;
      await setConfiguredUpstoxToken(token);

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error("OAuth error:", error.response?.data || error.message);
      res.status(500).send("Authentication failed. Please check your Upstox credentials.");
    }
  });

  // Spot Prices — live from Upstox if token present, else mock
  app.get("/api/spot", async (_req, res) => {
    const upstoxToken = getConfiguredUpstoxToken();

    if (upstoxToken && upstoxToken !== "YOUR_UPSTOX_API_TOKEN") {
      try {
        const instrumentKeys = [
          "NSE_INDEX|Nifty 50",
          "NSE_INDEX|Bank Nifty",
          "BSE_INDEX|SENSEX",
          "NSE_INDEX|Nifty Fin Service",
        ].join(",");

        const response = await axios.get(
          `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKeys)}`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${upstoxToken}`,
            },
          }
        );

        if (response.data?.data) {
          const d = response.data.data;
          return res.json({
            nifty: d["NSE_INDEX:Nifty 50"]?.last_price ?? 0,
            banknifty: d["NSE_INDEX:Bank Nifty"]?.last_price ?? 0,
            sensex: d["BSE_INDEX:SENSEX"]?.last_price ?? 0,
            finnifty: d["NSE_INDEX:Nifty Fin Service"]?.last_price ?? 0,
            giftnifty: 0,
          });
        }
      } catch (error) {
        console.error(`Error fetching spot from Upstox, falling back to mock: ${extractApiError(error)}`);
      }
    }

    // Mock fallback
    res.json({
      nifty: 22450.5 + (Math.random() * 10 - 5),
      banknifty: 47890.2 + (Math.random() * 20 - 10),
      sensex: 73800.1 + (Math.random() * 30 - 15),
      finnifty: 21200.4 + (Math.random() * 10 - 5),
      giftnifty: 22500.0 + (Math.random() * 10 - 5),
    });
  });

  // ── EOD Participants — real NSE participant-wise OI data ────────────────────
  // Source: https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv
  // We use OI columns (outstanding positions), NOT intraday traded volume columns.
  // Segments: Index Futures · Index Calls · Index Puts · Stock Futures
  // Participants: FII → FIIs, DII → DIIs, Pro → PROs, Client → Clients
  const nseOiCache = new Map<string, any[]>();

  // ── Disk-based NSE cache ───────────────────────────────────────────────────
  // Allows manually-uploaded CSVs to persist across server restarts.
  // Location: ./data/nse-oi/ directory (created on first use)
  const NSE_DISK_DIR = path.join(process.cwd(), "data", "nse-oi");
  try { fs.mkdirSync(NSE_DISK_DIR, { recursive: true }); } catch {}

  function nseDiskPath(key: string) { return path.join(NSE_DISK_DIR, `${key}.json`); }

  function loadDiskCache(key: string): any[] | null {
    try {
      const raw = fs.readFileSync(nseDiskPath(key), "utf-8");
      return JSON.parse(raw);
    } catch { return null; }
  }

  function saveDiskCache(key: string, data: any[]) {
    try { fs.writeFileSync(nseDiskPath(key), JSON.stringify(data)); } catch {}
  }

  function parseCsvText(text: string): ReturnType<typeof parseNseRow>[] | null {
    if (!text.includes("Client Type")) return null;
    const lines = text.trim().split(/\r?\n/);
    // The first line is a title row; find the actual header row by locating "Client Type"
    const headerIdx = lines.findIndex(l => l.split(",").map(h => h.trim()).includes("Client Type"));
    if (headerIdx === -1) return null;
    const headers = lines[headerIdx].split(",").map(h => h.trim());
    const rows = lines.slice(headerIdx + 1)
      .filter(l => l.trim())
      .map(line => {
        const vals = line.split(",").map(v => v.trim());
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
        return obj;
      })
      .filter(r => r["Client Type"] && ["FII","DII","Pro","Client"].includes(r["Client Type"].trim()));
    if (rows.length === 0) return null;
    return rows.map(parseNseRow);
  }

  // Upload endpoint: POST /api/eod-participants/upload
  // Body: multipart form with field "csv" (text/csv file) and optional "datekey" (DDMMYYYY)
  // Or raw CSV text with header X-NSE-Date: DDMMYYYY
  app.post("/api/eod-participants/upload", express.text({ type: "*/*", limit: "2mb" }), (req, res) => {
    const dateKey = (req.headers["x-nse-date"] as string | undefined)?.trim()
      || req.query.date as string | undefined;
    const body = req.body as string;
    if (!body || typeof body !== "string") return res.status(400).json({ error: "Send raw CSV text in request body" });
    // Show first 300 chars in error so the user/dev can see what was actually received
    const preview = body.slice(0, 300).replace(/\r/g, "").trim();
    const isHtml = body.trimStart().startsWith("<");
    if (isHtml) {
      return res.status(400).json({
        error: "Received an HTML page instead of CSV. The NSE link returned a webpage — the file for this date may not be published yet, or you saved the wrong file.",
        preview,
      });
    }
    const parsed = parseCsvText(body);
    if (!parsed) return res.status(400).json({
      error: "Invalid NSE CSV — could not find 'Client Type' column. Expected NSE participant OI format.",
      preview,
      hint: "First line of your file was: " + body.split("\n")[0]?.slice(0, 120),
    });

    // Determine the date key: from header, or from the CSV itself if it has a date column
    let key = dateKey;
    if (!key) {
      // Try to extract from first data row — NSE CSV doesn't have a date column,
      // so we default to today
      const today = new Date();
      key = nseFileDateStr(today);
    }
    nseOiCache.set(key, parsed);
    saveDiskCache(key, parsed);
    console.log(`[nse] uploaded & cached participant OI for ${key}: ${parsed.length} rows`);
    return res.json({ ok: true, dateKey: key, rows: parsed.length });
  });

  function nseFileDateStr(d: Date): string {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}${mm}${d.getFullYear()}`;
  }

  function nseDisplayDate(d: Date): string {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
  }

  function isWeekend(d: Date): boolean {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  // Parse one CSV row → raw OI values per participant.
  // Actual NSE column names (fao_participant_oi_DDMMYYYY.csv):
  //   Future Index Long / Future Index Short
  //   Option Index Call Long / Option Index Call Short
  //   Option Index Put Long  / Option Index Put Short
  //   Future Stock Long      / Future Stock Short
  function parseNseRow(row: Record<string, string>) {
    const n = (key: string) => parseInt((row[key] || "0").replace(/,/g, ""), 10) || 0;
    const rawName = (row["Client Type"] || "").trim();
    const nameMap: Record<string, string> = { FII: "FIIs", DII: "DIIs", Pro: "PROs", Client: "Clients" };
    return {
      name: nameMap[rawName] ?? rawName,
      idxFutLong:  n("Future Index Long"),
      idxFutShort: n("Future Index Short"),
      callLong:    n("Option Index Call Long"),
      callShort:   n("Option Index Call Short"),
      putLong:     n("Option Index Put Long"),
      putShort:    n("Option Index Put Short"),
      stkFutLong:  n("Future Stock Long"),
      stkFutShort: n("Future Stock Short"),
    };
  }

  // Download and parse NSE participant OI CSV for a given date.
  // Priority: in-memory cache → disk cache → network fetch
  async function fetchNseParticipantOI(date: Date): Promise<ReturnType<typeof parseNseRow>[] | null> {
    const key = nseFileDateStr(date);
    // 1. In-memory
    if (nseOiCache.has(key)) return nseOiCache.get(key)!;
    // 2. Disk cache (from a previous manual upload or successful fetch)
    const disk = loadDiskCache(key);
    if (disk && disk.length > 0) { nseOiCache.set(key, disk); return disk; }
    // 3. Network
    const url = `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${key}.csv`;
    try {
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120",
          "Accept": "text/csv,*/*",
          "Referer": "https://www.nseindia.com/",
        },
        timeout: 12000,
        responseType: "text",
      });
      const text: string = typeof resp.data === "string" ? resp.data : String(resp.data);
      const parsed = parseCsvText(text);
      if (!parsed) { console.warn(`[nse] invalid CSV for ${key}`); return null; }
      nseOiCache.set(key, parsed);
      saveDiskCache(key, parsed);
      console.log(`[nse] fetched participant OI for ${key}: ${parsed.length} rows`);
      return parsed;
    } catch (e: any) {
      console.error(`[nse] fetch failed for ${key}:`, e.message);
      return null;
    }
  }

  // ── EOD endpoint — returns OI changes, 5-day net position trend, verdict ────
  app.get("/api/eod-participants", async (_req, res) => {
    // Fetch 6 trading days: day0 (latest) through day5.
    // We need day5 so we can compute day4's daily change (day4 - day5).
    const tradingDays: Array<{ date: Date; label: string; rows: ReturnType<typeof parseNseRow>[] }> = [];
    let offset = 0;
    while (tradingDays.length < 6 && offset < 20) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      offset++;
      if (isWeekend(d)) continue;
      const rows = await fetchNseParticipantOI(d);
      if (!rows || rows.length === 0) continue;
      tradingDays.push({ date: d, label: nseDisplayDate(d), rows });
    }
    if (tradingDays.length === 0) {
      return res.status(503).json({ error: "NSE data unavailable. Markets may be closed or NSE archive is unreachable." });
    }

    const PARTICIPANTS = ["FIIs", "DIIs", "PROs", "Clients"] as const;
    type P = typeof PARTICIPANTS[number];
    type SegCfg = { name: string; lk: keyof ReturnType<typeof parseNseRow>; sk: keyof ReturnType<typeof parseNseRow>; isPuts: boolean };
    const SEGMENTS: SegCfg[] = [
      { name: "Index Futures", lk: "idxFutLong", sk: "idxFutShort", isPuts: false },
      { name: "Index Calls",   lk: "callLong",   sk: "callShort",   isPuts: false },
      { name: "Index Puts",    lk: "putLong",     sk: "putShort",    isPuts: true  },
      { name: "Stock Futures", lk: "stkFutLong",  sk: "stkFutShort", isPuts: false },
    ];

    const getRaw = (dayIdx: number, pName: string, key: string): number => {
      const r = tradingDays[dayIdx]?.rows.find(r => r.name === pName);
      return (r as any)?.[key] ?? 0;
    };

    const netOI = (dayIdx: number, pName: string, seg: SegCfg) =>
      getRaw(dayIdx, pName, seg.lk) - getRaw(dayIdx, pName, seg.sk);

    const segments = SEGMENTS.map(seg => {
      const rows = PARTICIPANTS.map(pName => {
        const l0 = getRaw(0, pName, seg.lk), s0 = getRaw(0, pName, seg.sk);
        const l1 = getRaw(1, pName, seg.lk), s1 = getRaw(1, pName, seg.sk);

        const longsChange  = l0 - l1;
        const shortsChange = s0 - s1;
        const netToday     = l0 - s0;
        const net1dAgo     = l1 - s1;
        const netChange    = netToday - net1dAgo;

        // 5-day net positions for trend sparkline (index 0 = oldest, 4 = today)
        const trend5d = [4, 3, 2, 1, 0].map(i => ({
          label: tradingDays[i]?.label ?? "",
          net: tradingDays[i] ? netOI(i, pName, seg) : null,
          // daily change vs previous day (i+1)
          change: tradingDays[i] && tradingDays[i + 1]
            ? netOI(i, pName, seg) - netOI(i + 1, pName, seg)
            : null,
        }));

        // Streak: how many consecutive days has net been moving in the same direction?
        let streak = 0;
        let streakDir = 0;
        for (let i = 4; i >= 1; i--) {
          const ch = trend5d[i].change;
          if (ch === null) break;
          const dir = seg.isPuts ? (ch > 0 ? -1 : ch < 0 ? 1 : 0) : (ch > 0 ? 1 : ch < 0 ? -1 : 0);
          if (streak === 0) { streak = 1; streakDir = dir; }
          else if (dir === streakDir && dir !== 0) streak++;
          else break;
        }

        const sentiment = seg.isPuts
          ? (netChange > 0 ? "bearish" : netChange < 0 ? "bullish" : "neutral")
          : (netChange > 0 ? "bullish" : netChange < 0 ? "bearish" : "neutral");

        return {
          participant: pName as P,
          longsChange, shortsChange,
          longsAction:  longsChange  >= 0 ? "added longs"  : "Closed longs",
          shortsAction: shortsChange >= 0 ? "added shorts" : "Closed shorts",
          netToday, net1dAgo, netChange,
          tradeAction: netChange >= 0 ? "bought net" : "sold net",
          sentiment,
          trend5d,
          streak: { days: streak, direction: streakDir },
        };
      });

      return {
        name: seg.name, isPuts: seg.isPuts,
        rows,
        totalLongsChange:  rows.reduce((s, r) => s + r.longsChange,  0),
        totalShortsChange: rows.reduce((s, r) => s + r.shortsChange, 0),
      };
    });

    // Build a plain-English "verdict" for FII Index Futures (the #1 signal)
    const fiiIdxFut = segments[0].rows.find(r => r.participant === "FIIs")!;
    const clientIdxFut = segments[0].rows.find(r => r.participant === "Clients")!;
    const fiiPuts = segments[2].rows.find(r => r.participant === "FIIs")!;
    const streakLabel = fiiIdxFut.streak.days >= 2
      ? ` for ${fiiIdxFut.streak.days} consecutive days`
      : "";
    const diverge = Math.sign(fiiIdxFut.netToday) !== Math.sign(clientIdxFut.netToday);

    const fmtV = (n: number) => {
      const a = Math.abs(n);
      const sign = n >= 0 ? "+" : "−";
      if (a >= 100000) return sign + (a / 100000).toFixed(2) + "L";
      return sign + (a / 1000).toFixed(1) + "K";
    };

    let verdict = `FIIs are net ${fiiIdxFut.netToday < 0 ? "SHORT" : "LONG"} in Index Futures (${fmtV(fiiIdxFut.netToday)} contracts). `;
    verdict += `Today they ${fiiIdxFut.longsAction} ${fmtV(Math.abs(fiiIdxFut.longsChange))} and ${fiiIdxFut.shortsAction} ${fmtV(Math.abs(fiiIdxFut.shortsChange))}, `;
    verdict += `making their net position ${fmtV(fiiIdxFut.netChange)} ${fiiIdxFut.netChange < 0 ? "more short (bearish)" : "more long (bullish)"}${streakLabel}. `;
    if (fiiPuts.netToday > 0) verdict += `They also hold ${fmtV(fiiPuts.netToday)} net long puts — active hedging / bearish protection. `;
    if (diverge) verdict += `⚠️ Divergence: FIIs are net ${fiiIdxFut.netToday < 0 ? "short" : "long"} while retail clients are net ${clientIdxFut.netToday < 0 ? "short" : "long"} — follow FIIs.`;

    // ── Auto-sync today's NSE data → historical-oi (no manual CSV import needed) ─
    try {
      const todayIso = getISTDateStr(tradingDays[0].date);
      const hist = loadHistoricalOI();
      if (!hist.some(s => s.date === todayIso)) {
        hist.push({
          date: todayIso,
          niftyClose: null,
          participants: tradingDays[0].rows.map(r => ({
            name: r.name,
            idxFutLong: r.idxFutLong, idxFutShort: r.idxFutShort,
            callLong:   r.callLong,   callShort:   r.callShort,
            putLong:    r.putLong,    putShort:    r.putShort,
            stkFutLong: r.stkFutLong, stkFutShort: r.stkFutShort,
          })),
        });
        hist.sort((a, b) => a.date.localeCompare(b.date));
        saveHistoricalOI(hist);
        console.log(`[auto-sync] ${todayIso} synced → historical-oi (${hist.length} days total)`);
      }
    } catch (e: any) { console.error("[auto-sync]", e.message); }

    return res.json({
      date: tradingDays[0].label,
      trendDates: tradingDays.slice(0, 5).map(d => d.label).reverse(), // oldest→newest
      segments,
      verdict,
    });
  });

  // ── Futures Timeline API ─────────────────────────────────────────────────────
  app.get("/api/futures-timeline", async (_req, res) => {
    const tok = getConfiguredUpstoxToken();

    const stored = await getFuturesAsync();
    // If no stored data and market is open and we have a token, try an immediate capture
    if (stored.length === 0 && isMarketOpen() && tok && tok !== "YOUR_UPSTOX_API_TOKEN") {
      console.log("[futures] no stored data, triggering on-demand capture…");
      await captureFutures(tok);
    }
    return res.json(futuresBars);
  });

  // ── Futures Debug API (diagnose instrument key issues) ──────────────────────
  app.get("/api/futures-debug", async (_req, res) => {
    const tok = getConfiguredUpstoxToken();
    if (!tok || tok === "YOUR_UPSTOX_API_TOKEN") return res.json({ error: "no token" });
    try {
      // Reset cached key so we always rediscover
      cachedFuturesKey = "";
      const instrumentKey = await getNiftyFuturesKey(tok);
      const quoteRes = await axios.get(
        `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } }
      );
      return res.json({
        discoveredKey: instrumentKey,
        fallbackKey: getNiftyFuturesKeyFallback(),
        isMarketOpen: isMarketOpen(),
        activeToken: activeToken ? "set" : "empty",
        responseDataKeys: Object.keys(quoteRes.data?.data || {}),
        rawSample: quoteRes.data,
      });
    } catch (e: any) {
      return res.json({ error: e.message, stack: e.response?.data });
    }
  });

  // ── Live Timeline API (1-min bars, today only) ──────────────────────────────
  // Background poller handles capture; this route just returns stored data.
  app.get("/api/live-timeline/:strike", async (req, res) => {
    const strike = parseInt(req.params.strike, 10);
    if (isNaN(strike) || strike <= 0) return res.status(400).json({ error: "invalid strike" });
    return res.json(await getLiveHistoryAsync(strike));
  });

  // ── Strike Timeline API (3-min, 7-day history) ──────────────────────────────
  // Background poller handles capture; this route returns stored data.
  // Falls back to a single-strike on-demand fetch only if this strike has no data yet.
  app.get("/api/strike-timeline/:strike", async (req, res) => {
    const strike = parseInt(req.params.strike, 10);
    if (isNaN(strike) || strike <= 0) return res.status(400).json({ error: "invalid strike" });
    const tok = getConfiguredUpstoxToken();

    // Always return stored history first (background poller keeps it fresh)
    const stored = await getHistoryAsync(strike);
    if (stored.length > 0 || !isMarketOpen() || !tok || tok === "YOUR_UPSTOX_API_TOKEN") {
      return res.json(stored);
    }

    // No stored data yet AND market is open AND we have a token → do a one-off fetch
    try {
      const expiry = await getWeeklyExpiry(tok);
      if (!expiry) return res.json([]);
      const chainRes = await axios.get(
        `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${expiry}`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } }
      );
      const sd = (chainRes.data?.data || []).find((s: any) => s.strike_price === strike);
      if (sd) {
        const prev = getHistory(strike)[0];
        const point = buildPoint(sd, prev);
        const updated = await appendToHistory(strike, point);
        return res.json(updated);
      }
    } catch (err) {
      console.error("Strike timeline on-demand fetch failed:", err);
    }
    return res.json([]);
  });

  // ── Sensex Option Chain ─────────────────────────────────────────────────────
  app.get("/api/sensex/option-chain", async (_req, res) => {
    const tok = getConfiguredUpstoxToken();
    if (tok && tok !== "YOUR_UPSTOX_API_TOKEN") {
      try {
        const contractsRes = await axios.get(
          "https://api.upstox.com/v2/option/contract?instrument_key=BSE_INDEX|SENSEX",
          { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } }
        );
        if (contractsRes.data?.data) {
          const set = new Set<string>();
          contractsRes.data.data.forEach((c: any) => { if (c.expiry) set.add(c.expiry); });
          const sorted = Array.from(set).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
          const weekly = pickSensexExpiries(sorted);
          if (weekly.length >= 1) {
            const cw = weekly[0], nw = weekly[1] || weekly[0];
            const mapChain = (data: any[]) =>
              data.map((item: any) => ({
                strike: item.strike_price,
                callOI:  item.call_options?.market_data?.oi  || 0,
                callCOI: (item.call_options?.market_data?.oi || 0) - (item.call_options?.market_data?.prev_oi || 0),
                callLTP: (item.call_options?.market_data?.ltp || 0).toFixed(2),
                putOI:   item.put_options?.market_data?.oi   || 0,
                putCOI:  (item.put_options?.market_data?.oi  || 0) - (item.put_options?.market_data?.prev_oi  || 0),
                putLTP:  (item.put_options?.market_data?.ltp  || 0).toFixed(2),
              })).sort((a: any, b: any) => a.strike - b.strike);

            const [cwRes, nwRes] = await Promise.all([
              axios.get(`https://api.upstox.com/v2/option/chain?instrument_key=BSE_INDEX|SENSEX&expiry_date=${cw}`,
                { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } }),
              weekly.length >= 2
                ? axios.get(`https://api.upstox.com/v2/option/chain?instrument_key=BSE_INDEX|SENSEX&expiry_date=${nw}`,
                    { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } })
                : Promise.resolve({ data: { data: [] } }),
            ]);
            return res.json({
              currentWeek: mapChain(cwRes.data.data || []),
              nextWeek:    mapChain(nwRes.data.data || []),
              expiries: { currentWeek: cw, nextWeek: nw },
            });
          }
        }
      } catch (e: any) { console.error("[sensex] option-chain:", e.message); }
    }
    // Mock fallback — Sensex ~77000, 500-pt intervals
    const spot = 77000;
    const strikes = Array.from({ length: 13 }, (_, i) => spot - 3000 + i * 500);
    const mockChain = strikes.map((s) => ({
      strike: s,
      callOI:  Math.floor(Math.random() * 400_000),
      callCOI: Math.floor(Math.random() * 40_000) - 10_000,
      callLTP: (Math.max(0, spot - s) + Math.random() * 300).toFixed(2),
      putOI:   Math.floor(Math.random() * 400_000),
      putCOI:  Math.floor(Math.random() * 40_000) - 10_000,
      putLTP:  (Math.max(0, s - spot) + Math.random() * 300).toFixed(2),
    }));
    res.json({ currentWeek: mockChain, nextWeek: mockChain, expiries: null });
  });

  // ── Sensex Strike Timeline ───────────────────────────────────────────────────
  app.get("/api/sensex/strike-timeline/:strike", async (req, res) => {
    const strike = parseInt(req.params.strike, 10);
    if (isNaN(strike) || strike <= 0) return res.status(400).json({ error: "invalid strike" });
    const tok = getConfiguredUpstoxToken();

    const stored = await getSensexHistoryAsync(strike);
    if (stored.length > 0 || !isMarketOpen() || !tok || tok === "YOUR_UPSTOX_API_TOKEN") {
      return res.json(stored);
    }
    try {
      const expiry = await getSensexExpiry(tok);
      if (!expiry) return res.json([]);
      const chainRes = await axios.get(
        `https://api.upstox.com/v2/option/chain?instrument_key=BSE_INDEX|SENSEX&expiry_date=${expiry}`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` } }
      );
      const sd = (chainRes.data?.data || []).find((s: any) => s.strike_price === strike);
      if (sd) {
        const prev = getSensexHistory(strike)[0];
        const point = buildPoint(sd, prev, SENSEX_LOT_SIZE);
        const updated = await appendSensexHistory(strike, point);
        return res.json(updated);
      }
    } catch (err) {
      console.error("[sensex] strike-timeline on-demand failed:", err);
    }
    return res.json([]);
  });

  // ── Option Chain API ────────────────────────────────────────────────────────
  app.get("/api/option-chain", async (_req, res) => {
    const upstoxToken = getConfiguredUpstoxToken();

    if (upstoxToken && upstoxToken !== "YOUR_UPSTOX_API_TOKEN") {
      try {
        const contractsRes = await axios.get(
          "https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX|Nifty%2050",
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${upstoxToken}`,
            },
          }
        );

        if (contractsRes.data?.data) {
          const expiriesSet = new Set<string>();
          contractsRes.data.data.forEach((contract: any) => {
            if (contract.expiry) expiriesSet.add(contract.expiry);
          });

          const sorted = Array.from(expiriesSet).sort(
            (a, b) => new Date(a).getTime() - new Date(b).getTime()
          );

          // Prefer Tuesday weekly expiries for NIFTY
          const weeklyExpiries = pickWeeklyExpiries(sorted);

          if (weeklyExpiries.length >= 2) {
            const currentWeekExpiry = weeklyExpiries[0];
            const nextWeekExpiry = weeklyExpiries[1];

            const [currentWeekRes, nextWeekRes] = await Promise.all([
              axios.get(
                `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${currentWeekExpiry}`,
                {
                  headers: { Accept: "application/json", Authorization: `Bearer ${upstoxToken}` },
                }
              ),
              axios.get(
                `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${nextWeekExpiry}`,
                {
                  headers: { Accept: "application/json", Authorization: `Bearer ${upstoxToken}` },
                }
              ),
            ]);

            const mapUpstoxData = (data: any[]) =>
              data
                .map((item: any) => {
                  const callData = item.call_options?.market_data || {};
                  const putData = item.put_options?.market_data || {};
                  return {
                    strike: item.strike_price,
                    callOI: callData.oi || 0,
                    callCOI: (callData.oi || 0) - (callData.prev_oi || 0),
                    callLTP: (callData.ltp || 0).toFixed(2),
                    putOI: putData.oi || 0,
                    putCOI: (putData.oi || 0) - (putData.prev_oi || 0),
                    putLTP: (putData.ltp || 0).toFixed(2),
                  };
                })
                .sort((a, b) => a.strike - b.strike);

            const currentWeek = mapUpstoxData(currentWeekRes.data.data);
            const nextWeek = mapUpstoxData(nextWeekRes.data.data);

            return res.json({
              currentWeek,
              nextWeek,
              expiries: { currentWeek: currentWeekExpiry, nextWeek: nextWeekExpiry },
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching from Upstox API, falling back to mock data: ${extractApiError(error)}`);
      }
    }

    // Fallback to Mock Option Chain
    const strikes = [22000, 22100, 22200, 22300, 22400, 22500, 22600, 22700, 22800, 22900, 23000];
    const currentWeek = strikes.map((s) => ({
      strike: s,
      callOI: Math.floor(Math.random() * 3000000),
      callCOI: Math.floor(Math.random() * 500000) - 100000,
      callLTP: (Math.max(0, 22500 - s) + Math.random() * 100).toFixed(2),
      putOI: Math.floor(Math.random() * 3000000),
      putCOI: Math.floor(Math.random() * 500000) - 100000,
      putLTP: (Math.max(0, s - 22500) + Math.random() * 100).toFixed(2),
    }));
    const nextWeek = strikes.map((s) => ({
      strike: s,
      callOI: Math.floor(Math.random() * 1500000),
      callCOI: Math.floor(Math.random() * 200000) - 50000,
      callLTP: (Math.max(0, 22500 - s) + Math.random() * 150 + 50).toFixed(2),
      putOI: Math.floor(Math.random() * 1500000),
      putCOI: Math.floor(Math.random() * 200000) - 50000,
      putLTP: (Math.max(0, s - 22500) + Math.random() * 150 + 50).toFixed(2),
    }));

    res.json({ currentWeek, nextWeek, expiries: null });
  });

  // ── Smart Money AI — AI Memory Store: daily EOD analysis + strike watchlist ──
  const AI_MEMORY_FILE = path.join(process.cwd(), "data", "ai-memory.json");

  // One entry per predicted strike — tracked for 7 days
  interface StrikePrediction {
    index: "NIFTY" | "SENSEX";
    strike: number;
    type: "CE" | "PE";
    participant: "FIIs" | "PROs" | "DIIs";
    activity: string;           // "Call Writing", "Put Writing", "Call Buying", "Put Buying"
    simpleExplanation: string;  // plain English
    entryPremium: number;       // premium (LTP) on prediction date
    confidence: "HIGH" | "MEDIUM" | "LOW";
    predictedDate: string;      // YYYY-MM-DD
    premiumHistory: Array<{ date: string; premium: number }>; // daily tracking
    status: "ACTIVE" | "STOPPED";
  }

  // One entry per trading day — stores DeepSeek's full analysis
  interface DailyAIMemory {
    date: string;         // YYYY-MM-DD
    generatedAt: string;
    bias: "BULLISH" | "BEARISH" | "SIDEWAYS";
    confidence: string;
    narrative: string;    // What smart money did last 5 days (simple English)
    trapAlert: string;    // What trap is set for tomorrow (simple English)
    nextDayPlan: string;  // Concrete plan for next day (simple English)
    watchlist: StrikePrediction[];
    keyLevels: { support: number[]; resistance: number[] };
    reasoning: string;    // DeepSeek R1 chain-of-thought (hidden by default)
  }

  function loadAiMemory(): DailyAIMemory[] {
    try { return JSON.parse(fs.readFileSync(AI_MEMORY_FILE, "utf-8")); } catch { return []; }
  }
  function saveAiMemory(data: DailyAIMemory[]) {
    try {
      fs.mkdirSync(path.dirname(AI_MEMORY_FILE), { recursive: true });
      fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(data));
    } catch (e: any) { console.error("[ai-memory] save failed:", e.message); }
  }

  // Flexible date string → YYYY-MM-DD
  function parseDateStr(raw: string): string | null {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD-Mon-YYYY or DD Mon YYYY
    const m1 = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
    if (m1) {
      const months: Record<string, string> = {
        jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
        jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
      };
      const mm = months[m1[2].toLowerCase().slice(0, 3)];
      if (mm) return `${m1[3]}-${mm}-${m1[1].padStart(2, "0")}`;
    }
    // DD/MM/YYYY
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m2) return `${m2[3]}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`;
    // DDMMMYYYY e.g. 24Mar2026
    const m3 = s.match(/^(\d{2})([A-Za-z]{3})(\d{4})$/);
    if (m3) {
      const months: Record<string, string> = {
        jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
        jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
      };
      const mm = months[m3[2].toLowerCase()];
      if (mm) return `${m3[3]}-${mm}-${m3[1]}`;
    }
    return null;
  }

  // Parse a combined historical CSV (all days stacked, with a Date column)
  function parseHistoricalCsv(text: string): { date: string; rows: ReturnType<typeof parseNseRow>[] }[] | null {
    if (!text.includes("Client Type")) return null;
    const lines = text.trim().split(/\r?\n/);
    const headerIdx = lines.findIndex(l =>
      l.split(",").map(h => h.trim()).includes("Client Type")
    );
    if (headerIdx === -1) return null;
    const headers = lines[headerIdx].split(",").map(h => h.trim());
    // Find date column by header name, or fall back to first column
    let dateColIdx = headers.findIndex(h => /^date$/i.test(h) || /trade.?date/i.test(h));
    if (dateColIdx === -1) dateColIdx = 0; // assume first column is date

    const participantRows = lines.slice(headerIdx + 1)
      .filter(l => l.trim())
      .map(line => {
        const vals = line.split(",").map(v => v.trim());
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
        return obj;
      })
      .filter(r => ["FII","DII","Pro","Client"].includes((r["Client Type"] || "").trim()));

    if (participantRows.length === 0) return null;

    // Carry the last seen date forward — handles Excel CSV export where the
    // date cell is only populated on the first row of each date group.
    const byDate = new Map<string, typeof participantRows>();
    let lastDate: string | null = null;
    for (const row of participantRows) {
      const rawDate = row[headers[dateColIdx]] || "";
      const parsed = parseDateStr(rawDate);
      if (parsed) lastDate = parsed;
      const date = lastDate;
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(row);
    }
    if (byDate.size === 0) return null;

    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => ({ date, rows: rows.map(parseNseRow) }));
  }

  // Fetch Nifty 50 daily closing prices from Upstox for a date range
  async function fetchNiftyCloses(token: string, fromDate: string, toDate: string): Promise<Map<string, number>> {
    const closes = new Map<string, number>();
    try {
      const instrKey = encodeURIComponent("NSE_INDEX|Nifty 50");
      const url = `https://api.upstox.com/v3/historical-candle/${instrKey}/days/1/${toDate}/${fromDate}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 15000,
      });
      const candles: any[] = resp.data?.data?.candles ?? [];
      for (const c of candles) {
        // candle: [timestamp, open, high, low, close, volume, oi]
        const date = (c[0] as string).slice(0, 10); // YYYY-MM-DD
        closes.set(date, parseFloat(c[4]));
      }
    } catch (e: any) {
      console.error("[hist-oi] Nifty close fetch failed:", e.message);
    }
    return closes;
  }

  // POST /api/historical-oi/import — accepts combined CSV in request body
  app.post("/api/historical-oi/import", express.text({ type: "*/*", limit: "10mb" }), async (req, res) => {
    const body = req.body as string;
    if (!body || typeof body !== "string") return res.status(400).json({ error: "Send raw CSV text in request body" });

    const parsed = parseHistoricalCsv(body);
    if (!parsed) {
      const preview = body.slice(0, 200).replace(/\r/g, "").trim();
      return res.status(400).json({
        error: "Could not parse combined historical CSV. Expected a date column + 'Client Type' column with FII/DII/Pro/Client rows.",
        hint: "First line received: " + body.split("\n")[0]?.slice(0, 120),
        preview,
      });
    }

    // Load existing snapshots and merge (new data overwrites same dates)
    const existing = loadHistoricalOI();
    const byDate = new Map<string, DailyOISnapshot>(existing.map(s => [s.date, s]));

    for (const { date, rows } of parsed) {
      const existing = byDate.get(date);
      byDate.set(date, {
        date,
        niftyClose: existing?.niftyClose ?? null,
        participants: rows.map(r => ({
          name: r.name,
          idxFutLong: r.idxFutLong, idxFutShort: r.idxFutShort,
          callLong: r.callLong,     callShort: r.callShort,
          putLong: r.putLong,       putShort: r.putShort,
          stkFutLong: r.stkFutLong, stkFutShort: r.stkFutShort,
        })),
      });
    }

    const snapshots = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Try to backfill Nifty closes from Upstox if token available
    const token = getConfiguredUpstoxToken();
    if (token && token !== "YOUR_UPSTOX_API_TOKEN") {
      const dates = snapshots.filter(s => s.niftyClose === null).map(s => s.date);
      if (dates.length > 0) {
        const closes = await fetchNiftyCloses(token, dates[0], dates[dates.length - 1]);
        for (const snap of snapshots) {
          if (snap.niftyClose === null && closes.has(snap.date)) {
            snap.niftyClose = closes.get(snap.date)!;
          }
        }
      }
    }

    saveHistoricalOI(snapshots);
    res.json({
      imported: parsed.length,
      total: snapshots.length,
      dateRange: snapshots.length > 0 ? { from: snapshots[0].date, to: snapshots[snapshots.length - 1].date } : null,
      withNiftyClose: snapshots.filter(s => s.niftyClose !== null).length,
    });
  });

  // GET /api/historical-oi — return stored snapshots summary + last N rows
  app.get("/api/historical-oi", (req, res) => {
    const snapshots = loadHistoricalOI();
    const limit = parseInt((req.query.limit as string) || "90", 10);
    const recent = snapshots.slice(-limit);
    res.json({
      total: snapshots.length,
      dateRange: snapshots.length > 0 ? { from: snapshots[0].date, to: snapshots[snapshots.length - 1].date } : null,
      snapshots: recent,
    });
  });

  // POST /api/ai/analyze — run DeepSeek R1 over historical OI data
  app.post("/api/ai/analyze", async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "DEEPSEEK_API_KEY not configured" });

    const snapshots = loadHistoricalOI();
    if (snapshots.length < 5) {
      return res.status(400).json({ error: "Not enough historical data. Import at least 5 days of OI data first." });
    }

    const days = snapshots.slice(-90); // last 90 trading days max

    // Build data table for prompt
    const header = "Date       | Nifty  | FII_IdxFut | FII_Call  | FII_Put   | DII_IdxFut | PRO_IdxFut | PRO_Call  | PRO_Put   | CLI_IdxFut";
    const divider = "-".repeat(header.length);
    const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString("en-IN").padStart(10);
    const rows = days.map(s => {
      const fii = s.participants.find(p => p.name === "FIIs");
      const dii = s.participants.find(p => p.name === "DIIs");
      const pro = s.participants.find(p => p.name === "PROs");
      const cli = s.participants.find(p => p.name === "Clients");
      const nifty = s.niftyClose != null ? s.niftyClose.toFixed(0).padStart(6) : "  N/A ";
      if (!fii || !dii || !pro || !cli) return null;
      return [
        s.date,
        nifty,
        fmt(fii.idxFutLong - fii.idxFutShort),
        fmt(fii.callLong   - fii.callShort),
        fmt(fii.putLong    - fii.putShort),
        fmt(dii.idxFutLong - dii.idxFutShort),
        fmt(pro.idxFutLong - pro.idxFutShort),
        fmt(pro.callLong   - pro.callShort),
        fmt(pro.putLong    - pro.putShort),
        fmt(cli.idxFutLong - cli.idxFutShort),
      ].join(" | ");
    }).filter(Boolean).join("\n");

    const dataTable = [header, divider, rows].join("\n");

    const systemPrompt = `You are a quantitative analyst with 15 years of experience specializing in NSE (India) equity derivatives markets. You are an expert at reading institutional participant open interest data to identify smart money positioning.

Key interpretations:
- Net = Long contracts − Short contracts. Positive = net long (bullish), Negative = net short (bearish).
- FIIs (Foreign Institutional Investors): primary smart money driver for index futures. Their index future net is the single most important signal.
- DIIs (Domestic Institutional Investors): often act as a counterweight to FIIs. Strong DII buying into FII selling = potential support.
- PROs (Proprietary traders / brokers): sophisticated, often hedged. Their net call/put positions reveal dealer gamma positioning.
- Clients (Retail): generally contrarian indicator. When clients are heavily long, market often tops; heavily short = floor.

Be specific, data-driven, and direct. Reference actual numbers from the data.`;

    const userPrompt = `Here is NSE participant-wise OI data (net contracts = long − short) for the last ${days.length} trading days, with Nifty 50 closing prices:

${dataTable}

Please analyze and provide:

1. **SIGNAL**: Bullish / Bearish / Neutral for the next 1–3 trading sessions
2. **CONFIDENCE**: High / Medium / Low
3. **KEY PATTERNS**: What smart money (FIIs) has been doing over the last 30 days — are they building longs, covering shorts, writing calls/puts?
4. **LAST 5 DAYS**: Any notable shift in positioning in the most recent 5 sessions?
5. **DIVERGENCES**: Any unusual divergence between FIIs and DIIs, or between FII futures and options positioning?
6. **RETAIL TRAP CHECK**: What are Clients doing? Is the market positioned for a squeeze?
7. **RISKS TO THESIS**: 2–3 specific factors that would invalidate your signal
8. **LEVELS TO WATCH**: Based on PRO options positioning (call/put net), what strikes or ranges appear significant?

Be specific and reference actual numbers from the data.`;

    try {
      const resp = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-reasoner",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 180000, // R1 can take up to 3 min
        }
      );

      const choice = resp.data?.choices?.[0];
      if (!choice) return res.status(502).json({ error: "Empty response from DeepSeek" });

      res.json({
        signal: choice.message?.content ?? "",
        reasoning: choice.message?.reasoning_content ?? "",
        model: resp.data?.model ?? "deepseek-reasoner",
        daysAnalyzed: days.length,
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error("[ai/analyze] DeepSeek error:", msg);
      res.status(502).json({ error: `DeepSeek API error: ${msg}` });
    }
  });

  // ── Daily Pre-Market Brief (8:30 AM IST = 03:00 UTC) ────────────────────────

  const DAILY_BRIEF_FILE = path.join(process.cwd(), "data", "daily-brief.json");

  interface DailyBrief {
    date: string;        // YYYY-MM-DD (trading date this brief is for)
    generatedAt: string; // ISO timestamp
    signal: string;      // R1 final answer
    reasoning: string;   // R1 chain of thought
    daysAnalyzed: number;
  }

  function loadDailyBrief(): DailyBrief | null {
    try { return JSON.parse(fs.readFileSync(DAILY_BRIEF_FILE, "utf-8")); } catch { return null; }
  }

  function saveDailyBrief(brief: DailyBrief) {
    try {
      fs.mkdirSync(path.dirname(DAILY_BRIEF_FILE), { recursive: true });
      fs.writeFileSync(DAILY_BRIEF_FILE, JSON.stringify(brief));
    } catch (e: any) { console.error("[brief] save failed:", e.message); }
  }

  async function generateDailyBrief(force = false): Promise<void> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) { console.warn("[brief] DEEPSEEK_API_KEY not set, skipping brief"); return; }

    const snapshots = loadHistoricalOI();
    if (snapshots.length < 5) { console.warn("[brief] not enough OI history for brief"); return; }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
    if (!force) {
      const existing = loadDailyBrief();
      if (existing?.date === today) { console.log("[brief] today's brief already generated"); return; }
    }

    console.log(`[brief] generating pre-market brief for ${today}…`);

    const days = snapshots.slice(-60);
    const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString("en-IN").padStart(10);
    const header = "Date       | Nifty  | FII_IdxFut | FII_Call  | FII_Put   | DII_IdxFut | PRO_IdxFut | PRO_Call  | PRO_Put   | CLI_IdxFut";
    const tableRows = days.map(s => {
      const fii = s.participants.find(p => p.name === "FIIs");
      const dii = s.participants.find(p => p.name === "DIIs");
      const pro = s.participants.find(p => p.name === "PROs");
      const cli = s.participants.find(p => p.name === "Clients");
      const nifty = s.niftyClose != null ? s.niftyClose.toFixed(0).padStart(6) : "  N/A ";
      if (!fii || !dii || !pro || !cli) return null;
      return [
        s.date, nifty,
        fmt(fii.idxFutLong - fii.idxFutShort), fmt(fii.callLong - fii.callShort),
        fmt(fii.putLong - fii.putShort),        fmt(dii.idxFutLong - dii.idxFutShort),
        fmt(pro.idxFutLong - pro.idxFutShort),  fmt(pro.callLong - pro.callShort),
        fmt(pro.putLong - pro.putShort),         fmt(cli.idxFutLong - cli.idxFutShort),
      ].join(" | ");
    }).filter(Boolean).join("\n");

    const dataTable = [header, "-".repeat(header.length), tableRows].join("\n");
    const lastClose = [...days].reverse().find(s => s.niftyClose != null);

    const systemPrompt = `You are a pre-market analyst for NSE equity derivatives with 15 years of experience. Every morning at 8:30 AM IST you deliver a crisp, actionable pre-market brief based on participant open interest data. Your briefs are concise, specific, and directly useful to a trader sitting down before the 9:15 AM open.`;

    const userPrompt = `Today is ${today}. Last Nifty close: ${lastClose?.niftyClose?.toFixed(0) ?? "N/A"} (${lastClose?.date ?? "N/A"}).

Participant OI data — last ${days.length} trading days (net = long − short):

${dataTable}

Deliver today's pre-market brief with exactly these sections:

**OPENING BIAS**: [Bullish / Bearish / Neutral] — one sentence explaining why based on FII positioning.

**FII PULSE**: What have FIIs been doing in index futures and options over the last 5 sessions? Are they accumulating, distributing, or hedging?

**SMART MONEY vs RETAIL**: How are DIIs and Clients positioned vs FIIs? Any divergence worth noting?

**KEY LEVEL TO WATCH**: Based on PRO options net (call/put), what strike zone appears most significant today?

**ONE RISK**: The single most important thing that could invalidate today's bias.

Keep it under 250 words. Be direct — no filler.`;

    try {
      const resp = await axios.post(
        "https://api.deepseek.com/chat/completions",
        { model: "deepseek-reasoner", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] },
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 180000 }
      );
      const choice = resp.data?.choices?.[0];
      if (!choice) { console.error("[brief] empty response from DeepSeek"); return; }
      saveDailyBrief({ date: today, generatedAt: new Date().toISOString(), signal: choice.message?.content ?? "", reasoning: choice.message?.reasoning_content ?? "", daysAnalyzed: days.length });
      console.log(`[brief] pre-market brief for ${today} saved ✓`);
    } catch (e: any) {
      console.error("[brief] DeepSeek error:", e.response?.data?.error?.message || e.message);
    }
  }

  function scheduleDailyBrief() {
    function msUntilNext0300UTC(): number {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(3, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime() - now.getTime();
    }
    function scheduleNext() {
      const ms = msUntilNext0300UTC();
      console.log(`[brief] next pre-market brief in ${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`);
      setTimeout(async () => { await generateDailyBrief(); scheduleNext(); }, ms);
    }
    scheduleNext();
    // Also run on startup if we're already past 8:30 AM IST and haven't generated today's brief
    const istHour = parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }), 10);
    if (istHour >= 8 && istHour < 16) generateDailyBrief(); // fire-and-forget startup catch-up
  }

  // GET /api/ai/daily-brief
  app.get("/api/ai/daily-brief", (_req, res) => {
    const brief = loadDailyBrief();
    if (!brief) return res.status(404).json({ error: "No brief yet — will auto-generate at 8:30 AM IST on the next weekday." });
    res.json(brief);
  });

  // POST /api/ai/daily-brief/refresh — force regenerate
  app.post("/api/ai/daily-brief/refresh", async (_req, res) => {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(503).json({ error: "DEEPSEEK_API_KEY not configured" });
    if (loadHistoricalOI().length < 5) return res.status(400).json({ error: "Not enough historical data." });
    res.json({ message: "Generating brief… ready in ~60 seconds. Refresh the page." });
    generateDailyBrief(true); // fire-and-forget
  });

  scheduleDailyBrief();

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART MONEY EOD ANALYSIS — DeepSeek daily learning loop
  // Flow: market closes → take OC snapshot → DeepSeek reads 5-day participant
  //       data + its own previous analyses → outputs narrative, trap, watchlist,
  //       next-day plan → stores in ai-memory → repeats every trading day
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Step 1: Take ATM ±600 option chain snapshot at 3:30 PM IST ──────────────
  async function takeOcSnapshot(token: string): Promise<void> {
    const today = getISTDateStr(new Date());
    const existing = loadOcSnapshots();
    if (existing.some(s => s.date === today)) {
      console.log("[oc-snap] snapshot already taken for", today); return;
    }
    try {
      // Nifty spot price
      let niftySpot = 0;
      try {
        const spotRes = await axios.get(
          "https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050",
          { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
        const d = spotRes.data?.data || {};
        niftySpot = (Object.values(d)[0] as any)?.last_price || 0;
      } catch {}

      // Nifty option chain: ATM ±600
      let niftyStrikes: OcSnapshotEntry["niftyStrikes"] = [];
      try {
        const expiry = await getWeeklyExpiry(token);
        if (expiry) {
          const chainRes = await axios.get(
            `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${expiry}`,
            { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
          const atm = Math.round((niftySpot || 24000) / 50) * 50;
          niftyStrikes = (chainRes.data?.data || [])
            .filter((s: any) => Math.abs(s.strike_price - atm) <= 600)
            .map((s: any) => ({
              strike:  s.strike_price,
              callOI:  s.call_options?.market_data?.oi      || 0,
              callCOI: (s.call_options?.market_data?.oi     || 0) - (s.call_options?.market_data?.prev_oi || 0),
              callLTP: s.call_options?.market_data?.ltp     || 0,
              putOI:   s.put_options?.market_data?.oi       || 0,
              putCOI:  (s.put_options?.market_data?.oi      || 0) - (s.put_options?.market_data?.prev_oi  || 0),
              putLTP:  s.put_options?.market_data?.ltp      || 0,
            }));
        }
      } catch (e: any) { console.error("[oc-snap] chain error:", e.message); }

      const snap: OcSnapshotEntry = {
        date: today, takenAt: new Date().toISOString(),
        niftySpot, niftyStrikes,
      };
      existing.push(snap);
      while (existing.length > OC_MAX_DAYS) existing.shift(); // keep last 7 days
      saveOcSnapshots(existing);
      console.log(`[oc-snap] saved ${today}: ${niftyStrikes.length} strikes, spot≈${Math.round(niftySpot)}`);
    } catch (e: any) { console.error("[oc-snap] failed:", e.message); }
  }

  // ── Step 2: Update premium history for all active watchlist entries ──────────
  let _watchlistUpdateLock = false;
  function updateWatchlistPremiums(): void {
    if (_watchlistUpdateLock) return; // prevent concurrent read-modify-write
    _watchlistUpdateLock = true;
    try {
      const memory = loadAiMemory();
      if (memory.length === 0) return;
      const today = getISTDateStr(new Date());
      const todayOc = loadOcSnapshots().find(s => s.date === today);
      if (!todayOc) return;
      let changed = false;
      for (const entry of memory) {
        for (const w of entry.watchlist) {
          if (w.status === "STOPPED") continue;
          // Expire after 7 days
          const ageDays = (new Date(today).getTime() - new Date(w.predictedDate).getTime()) / 86400000;
          if (ageDays > 7) { w.status = "STOPPED"; changed = true; continue; }
          if (w.premiumHistory.some(h => h.date === today)) continue;
          const s = todayOc.niftyStrikes.find(s => s.strike === w.strike);
          if (s) {
            w.premiumHistory.push({ date: today, premium: w.type === "CE" ? s.callLTP : s.putLTP });
            changed = true;
          }
        }
      }
      if (changed) { saveAiMemory(memory); console.log("[watchlist] premiums updated for", today); }
    } finally {
      _watchlistUpdateLock = false;
    }
  }

  // ── Step 3: DeepSeek EOD Analysis — reads 5-day data + its own memory ────────
  async function generateEodAnalysis(force = false): Promise<void> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) { console.warn("[eod-analysis] DEEPSEEK_API_KEY not set"); return; }
    const today = getISTDateStr(new Date());
    const memory = loadAiMemory();
    if (!force && memory.some(m => m.date === today)) {
      console.log("[eod-analysis] already done for", today); return;
    }
    const snapshots = loadHistoricalOI();
    if (snapshots.length < 1) { console.warn("[eod-analysis] need at least 1 day of participant data"); return; }

    const last5 = snapshots.slice(-5);
    const ocList = loadOcSnapshots();
    const todayOc = ocList.find(x => x.date === today) || ocList[ocList.length - 1];
    const prevMemory = memory.slice(-5);

    // ── Build 7-day multi-day strike COI pattern from stored 3-min timeline ────
    // timelineStore holds 7 days of 3-min bars for every captured strike.
    // For each ATM±500 strike we compute: per-day total CE/PE COI + inferred
    // activity tag (CW=CallWrite, CB=CallBuy, PW=PutWrite, PB=PutBuy, CU/PU=Unwind).
    // A strike with CW on 5 of 7 days = strong persistent FII ceiling there.
    const atmGuess = (() => {
      if (todayOc && todayOc.niftySpot > 0) return Math.round(todayOc.niftySpot / 50) * 50;
      return 24000; // safe fallback
    })();

    // Collect all IST dates present in the timeline store
    const allTlDates = new Set<string>();
    timelineStore.forEach((bars: any[]) => {
      bars.forEach((b: any) => {
        if (b.isoTimestamp) allTlDates.add(getISTDateStr(new Date(b.isoTimestamp)));
      });
    });
    const tlDates = Array.from(allTlDates).sort().slice(-7); // last 7 trading days

    type DayAct = { cCOI: number; pCOI: number; cAct: string; pAct: string; cLTP: number; pLTP: number };

    const tlRows: string[] = [];
    for (let s = atmGuess - 500; s <= atmGuess + 500; s += 50) {
      const allBars: any[] = timelineStore.get(s) || [];
      if (allBars.length === 0) continue;

      const byDay: Record<string, DayAct> = {};
      for (const date of tlDates) {
        const dayBars = allBars.filter((b: any) =>
          b.isoTimestamp && getISTDateStr(new Date(b.isoTimestamp)) === date
        );
        if (dayBars.length < 2) continue;

        const cCOI = dayBars.reduce((acc: number, b: any) => acc + (b.call?.coi || 0), 0);
        const pCOI = dayBars.reduce((acc: number, b: any) => acc + (b.put?.coi  || 0), 0);
        const first = dayBars[0]; const last = dayBars[dayBars.length - 1];
        const cDir = parseFloat(last.call?.ltp || "0") - parseFloat(first.call?.ltp || "0");
        const pDir = parseFloat(last.put?.ltp  || "0") - parseFloat(first.put?.ltp  || "0");
        // Activity: OI rising + premium flat/down = writing; OI rising + premium up = buying
        const cAct = cCOI > 300 ? (cDir <= 0 ? "CW" : "CB") : cCOI < -300 ? "CU" : "-";
        const pAct = pCOI > 300 ? (pDir <= 0 ? "PW" : "PB") : pCOI < -300 ? "PU" : "-";
        byDay[date] = { cCOI, pCOI, cAct, pAct,
          cLTP: parseFloat(last.call?.ltp || "0"),
          pLTP: parseFloat(last.put?.ltp  || "0"),
        };
      }
      if (Object.keys(byDay).length === 0) continue;

      const vals = Object.values(byDay);
      const cwDays = vals.filter(d => d.cAct === "CW").length;
      const pwDays = vals.filter(d => d.pAct === "PW").length;
      const cbDays = vals.filter(d => d.cAct === "CB").length;
      const pbDays = vals.filter(d => d.pAct === "PB").length;
      // Skip if no meaningful repeated pattern
      if (cwDays + pwDays + cbDays + pbDays < 1) continue;

      const fc = (n: number) => ((n >= 0 ? "+" : "") + (n / 1000).toFixed(1) + "K").padStart(5);
      const dailyCols = tlDates.map(d => {
        const dd = byDay[d];
        if (!dd) return " —  ";
        return `CE:${fc(dd.cCOI)}[${dd.cAct}] PE:${fc(dd.pCOI)}[${dd.pAct}]`;
      }).join(" | ");

      // Dominant pattern label
      const patterns: string[] = [];
      if (cwDays >= 2) patterns.push(`CE_WRITE(${cwDays}d)`);
      if (pwDays >= 2) patterns.push(`PE_WRITE(${pwDays}d)`);
      if (cbDays >= 2) patterns.push(`CE_BUY(${cbDays}d)`);
      if (pbDays >= 2) patterns.push(`PE_BUY(${pbDays}d)`);

      // Latest LTP for reference
      const latestDay = byDay[tlDates[tlDates.length - 1]];
      const ltpRef = latestDay ? ` cLTP:${latestDay.cLTP.toFixed(1)} pLTP:${latestDay.pLTP.toFixed(1)}` : "";

      tlRows.push(`${s} |${ltpRef} | ${dailyCols} | ${patterns.join(" + ") || "activity<2d"}`);
    }

    const timelineDatesHeader = tlDates.join(" | ");
    const timelineTable = tlRows.length > 0
      ? `ATM≈${atmGuess} | Dates: [${timelineDatesHeader}]\nStrike | Latest LTP | Per-Day [CE_COI(act) PE_COI(act)] | Pattern\n${"─".repeat(120)}\n${tlRows.join("\n")}`
      : "No 3-min timeline data yet. Upstox must be connected during market hours to populate this. Analysis continues using EOD chain data only.";
    // ────────────────────────────────────────────────────────────────────────

    // Build participant net positions table (K = thousands of contracts)
    const pFmt = (n: number) => ((n >= 0 ? "+" : "") + (n / 1000).toFixed(1) + "K").padStart(8);
    const pNet = (snap: DailyOISnapshot, name: string, type: "fut" | "ce" | "pe") => {
      const p = snap.participants.find(p => p.name === name);
      if (!p) return 0;
      return type === "fut" ? p.idxFutLong - p.idxFutShort
           : type === "ce"  ? p.callLong   - p.callShort
                             : p.putLong    - p.putShort;
    };
    const pHead = "Date       | FII_Fut  | FII_CE   | FII_PE   | PRO_Fut  | PRO_CE   | PRO_PE   | DII_Fut  | Client_Fut";
    const pRows = last5.map(s =>
      `${s.date} |${pFmt(pNet(s,"FIIs","fut"))} |${pFmt(pNet(s,"FIIs","ce"))} |${pFmt(pNet(s,"FIIs","pe"))} |${pFmt(pNet(s,"PROs","fut"))} |${pFmt(pNet(s,"PROs","ce"))} |${pFmt(pNet(s,"PROs","pe"))} |${pFmt(pNet(s,"DIIs","fut"))} |${pFmt(pNet(s,"Clients","fut"))}`
    ).join("\n");
    const partTable = `${pHead}\n${"-".repeat(pHead.length)}\n${pRows}`;

    // Build EOD option chain snapshot table
    let ocTable = "No EOD option chain snapshot available for today — will be taken at 3:30 PM IST.";
    if (todayOc && todayOc.niftyStrikes.length > 0) {
      const h = "Strike  | CE_OI   | CE_COI  | CE_LTP | PE_OI   | PE_COI  | PE_LTP";
      const rows = todayOc.niftyStrikes.map(s =>
        `${s.strike} | ${(s.callOI/1000).toFixed(1)}K | ${s.callCOI>=0?"+":""}${(s.callCOI/1000).toFixed(1)}K | ${s.callLTP.toFixed(1)} | ${(s.putOI/1000).toFixed(1)}K | ${s.putCOI>=0?"+":""}${(s.putCOI/1000).toFixed(1)}K | ${s.putLTP.toFixed(1)}`
      ).join("\n");
      ocTable = `Nifty Spot: ~${Math.round(todayOc.niftySpot)}\n${h}\n${"-".repeat(h.length)}\n${rows}`;
    }

    // Previous analyses recap — DeepSeek learns from its own track record
    const memRecap = prevMemory.length === 0
      ? "No previous predictions yet — this is the first analysis."
      : prevMemory.map(m =>
          `${m.date} | Bias=${m.bias}(${m.confidence}) | Watchlist: ${
            m.watchlist.map(w => `${w.strike}${w.type}@₹${w.entryPremium}(${w.participant})`).join(", ") || "none"
          }`
        ).join("\n");

    const systemPrompt = `You are a smart money analyst for Indian equity derivatives (NSE Nifty 50).
Your job: cross-reference (1) institutional aggregate positioning from EOD participant data with (2) intraday 3-min strike-level OI patterns to identify EXACTLY which ATM/ITM strikes FIIs and PropDesk are active in.

WRITE IN SIMPLE ENGLISH — a first-time trader must understand every word.

═══ CRITICAL RULE — HOW FIIs ACTUALLY USE OPTIONS ═══
FIIs are NOT retail traders. They do NOT buy/write random OTM options. Here is how they really operate:

1. INDEX FUTURES = their PRIMARY directional instrument (most of their net long/short is in futures)

2. OPTIONS — FIIs use them in two distinct ways:
   A) DIRECTIONAL/INCOME trades → ALWAYS at ATM or ITM (within ±300 pts of current spot)
      - Call Writing at ATM/slight OTM = they expect market to stay below this level (resistance)
      - Put Writing at ATM/slight OTM = they expect market to stay above (support)
      - Call Buying at ITM/ATM = strong bullish directional bet
      - Put Buying at ATM/ITM = downside protection on a futures long
   B) PURE HEDGING → FAR OTM (>300 pts from spot)
      - Deep OTM puts/calls are tail-risk hedges — not signals of directional intent
      - A large OI at 24500 CE when spot is 22900 = plain vanilla hedge, NOT a resistance level they will defend
      - NEVER include far-OTM strikes in the watchlist as directional smart money signals

3. PROs/PropDesk typically do the OPPOSITE side of FIIs — if FIIs write calls, PropDesk buys them

4. CLIENTS/Retail are almost always on the wrong side — large retail longs at a strike = ceiling

═══ INTERPRETING 3-MIN COI PATTERNS ═══
- CE_WRITE: Call OI rose + premium fell/flat → Writing (selling) calls = ceiling being built (resistance)
- CE_BUY:   Call OI rose + premium rose → Buying calls = directional bullish bet
- PE_WRITE: Put OI rose + premium fell/flat → Writing puts = floor being built (support)
- PE_BUY:   Put OI rose + premium rose → Buying puts = directional bearish/hedge
- CE_UNWIND / PE_UNWIND: OI fell → position exited (potential breakout setup)

═══ CROSS-REFERENCE RULE ═══
- FIIs net short calls (EOD) + CE_WRITE at a strike within ATM±300 → FIIs likely writing there (key resistance)
- FIIs net long puts (EOD) + PE_BUY at ATM/ITM strike → FIIs buying puts for protection/directional bear
- PROs net short puts + PE_WRITE at a strike → PropDesk writing puts (support zone)
- Heavy retail long calls at a far OTM strike = distribution trap, not real resistance

═══ WATCHLIST CONSTRAINT — STRICTLY ENFORCED ═══
Only add strikes to the watchlist that are WITHIN ±300 points of today's spot. Far OTM strikes are hedges — they are irrelevant for the next trading day's directional analysis.

You MUST output ONLY valid JSON — no markdown, no extra text outside the JSON.`;

    const userPrompt = `Today: ${today}

## LAST ${last5.length} DAYS — PARTICIPANT NET POSITIONS (Long minus Short, in thousands of contracts):
${partTable}

## 7-DAY 3-MIN STRIKE TIMELINE — PER-STRIKE OI PATTERNS (ATM ±500):
${timelineTable}

HOW TO READ:
- CW = Call Writing (OI rose + premium fell/flat → selling calls, creating ceiling)
- CB = Call Buying (OI rose + premium rose → buying calls, bullish)
- PW = Put Writing (OI rose + premium fell/flat → selling puts, creating floor)
- PB = Put Buying (OI rose + premium rose → buying puts, bearish/hedge)
- CU/PU = Unwinding (OI fell → closing existing position)
- Pattern like "CE_WRITE(5d)" = call writing seen on 5 of 7 days = STRONG persistent ceiling there
- COI values are daily totals in thousands of contracts

## EOD OPTION CHAIN SNAPSHOT (closing OI & LTP):
${ocTable}

## YOUR PREVIOUS 5 ANALYSES (your track record — learn from this):
${memRecap}

YOUR TASK: Cross-reference the aggregate participant data (who is net short calls/puts) with the strike-level 3-min COI patterns (where OI actually built up) to pinpoint the specific ATM/ITM strikes where FIIs/PropDesk are active.

Output ONLY this JSON (no text outside it):
{
  "bias": "BULLISH" | "BEARISH" | "SIDEWAYS",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "narrative": "2-3 simple sentences. E.g. if spot is ~22900: 'FIIs are net short 2.6L in futures — clearly bearish. The 3-min data confirms they wrote calls at 23100 CE today (OI +14K, premium fell ₹18) — that is their ceiling for the week. They also bought puts at 22800 PE (OI +9K, premium rose) for downside protection.'",
  "trapAlert": "1-2 sentences: What trap is set for tomorrow? Name the exact ATM/ITM strike and who is on each side. E.g. 'FIIs have heavy put writing at 22700 PE — they want to pin the market above it. If retail panic-sells below 22700 intraday, FIIs will absorb it and bounce it back.'",
  "nextDayPlan": "3-4 sentences: Opening bias, key ATM/ITM level, and what to do if it breaks up or down.",
  "watchlist": [
    {
      "index": "NIFTY",
      "strike": 23100,
      "type": "CE",
      "participant": "FIIs",
      "activity": "Call Writing",
      "simpleExplanation": "FIIs wrote calls here — OI +14K while premium fell ₹18. Ceiling for the week.",
      "entryPremium": 85.5,
      "confidence": "HIGH"
    }
  ],
  "keyLevels": {
    "support": [22700, 22500],
    "resistance": [23100, 23300]
  }
}

WATCHLIST RULES — STRICTLY ENFORCE ALL:
1. Only include strikes within ±300 pts of today's spot price — NO exceptions
2. 3 to 8 strikes — only where EOD participant data + 3-min COI together give clear evidence
3. Prioritise CE_WRITE / PE_WRITE strikes that match the participant's known aggregate positioning
4. entryPremium = last LTP from 3-min data or EOD chain snapshot
5. simpleExplanation under 20 words, plain English, no jargon
6. If 3-min data unavailable, use EOD chain OI concentration at ATM±300 only
7. NEVER include strikes more than 300 pts from spot — those are hedges, not directional signals`;

    try {
      console.log("[eod-analysis] calling DeepSeek R1 with", last5.length, "days data...");
      const resp = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-reasoner",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt   },
          ],
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          timeout: 180000,
        }
      );
      const choice = resp.data?.choices?.[0];
      if (!choice) { console.error("[eod-analysis] empty response from DeepSeek"); return; }

      const rawContent = choice.message?.content ?? "";
      let parsed: any;
      try {
        const m = rawContent.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : rawContent);
      } catch {
        console.error("[eod-analysis] JSON parse failed. Raw:", rawContent.slice(0, 400));
        return;
      }

      const entry: DailyAIMemory = {
        date: today,
        generatedAt: new Date().toISOString(),
        bias:        parsed.bias        || "SIDEWAYS",
        confidence:  parsed.confidence  || "LOW",
        narrative:   parsed.narrative   || "",
        trapAlert:   parsed.trapAlert   || "",
        nextDayPlan: parsed.nextDayPlan || "",
        watchlist: (parsed.watchlist || []).map((w: any) => ({
          index:             w.index             || "NIFTY",
          strike:            w.strike            || 0,
          type:              w.type              || "CE",
          participant:       w.participant       || "FIIs",
          activity:          w.activity          || "",
          simpleExplanation: w.simpleExplanation || "",
          entryPremium:      w.entryPremium      || 0,
          confidence:        w.confidence        || "MEDIUM",
          predictedDate: today,
          premiumHistory: [{ date: today, premium: w.entryPremium || 0 }],
          status: "ACTIVE" as const,
        })),
        keyLevels: parsed.keyLevels || { support: [], resistance: [] },
        reasoning: choice.message?.reasoning_content ?? "",
      };

      const updated = loadAiMemory().filter(m => m.date !== today);
      updated.push(entry);
      while (updated.length > 90) updated.shift();
      saveAiMemory(updated);
      console.log(`[eod-analysis] ✓ ${today}: bias=${entry.bias}(${entry.confidence}), ${entry.watchlist.length} strikes`);
    } catch (e: any) {
      console.error("[eod-analysis] DeepSeek error:", e.response?.data?.error?.message || e.message);
    }
  }

  // ── Step 4: Scheduler — runs at market close every trading day ───────────────
  function scheduleEodAnalysis() {
    function msUntilUTC(h: number, m: number): number {
      const now = new Date();
      const t = new Date(now);
      t.setUTCHours(h, m, 0, 0);
      if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
      while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() + 1);
      return t.getTime() - now.getTime();
    }
    // 3:30 PM IST = 10:00 UTC — take OC snapshot
    function schedSnap() {
      const ms = msUntilUTC(10, 0);
      console.log(`[oc-snap] next snapshot in ${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`);
      setTimeout(async () => {
        if (activeToken && activeToken !== "YOUR_UPSTOX_API_TOKEN") {
          await takeOcSnapshot(activeToken);
          updateWatchlistPremiums();
        }
        schedSnap();
      }, ms);
    }
    // 3:45 PM IST = 10:15 UTC — run DeepSeek analysis + strike summary
    function schedAnalysis() {
      const ms = msUntilUTC(10, 15);
      console.log(`[eod-analysis] next analysis in ${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`);
      setTimeout(async () => {
        await generateEodAnalysis();
        generateEodStrikeAnalysis(); // fire-and-forget: ATM±400 strike summary
        schedAnalysis();
      }, ms);
    }
    schedSnap();
    schedAnalysis();
    // On startup: if it's already past 3:30 PM IST and today's data is missing, run now
    const istH = parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }), 10);
    if (istH >= 15 && istH < 22) {
      const today = getISTDateStr(new Date());
      const hasSnap         = loadOcSnapshots().some(s => s.date === today);
      const hasAnalysis     = loadAiMemory().some(m => m.date === today);
      const hasStrikeSummary = (() => {
        try {
          const d = JSON.parse(fs.readFileSync(EOD_STRIKE_SUMMARY_FILE, "utf-8"));
          return Array.isArray(d) && d.some((x: any) => x.date === today);
        } catch { return false; }
      })();
      if (!hasSnap && activeToken && activeToken !== "YOUR_UPSTOX_API_TOKEN") {
        takeOcSnapshot(activeToken).then(() => {
          updateWatchlistPremiums();
          if (!hasAnalysis) generateEodAnalysis().then(() => {
            if (!hasStrikeSummary) generateEodStrikeAnalysis();
          });
        }).catch((e: any) => console.error("[eod] snapshot error:", e.message));
      } else if (!hasAnalysis) {
        generateEodAnalysis().then(() => {
          if (!hasStrikeSummary) generateEodStrikeAnalysis();
        });
      } else if (!hasStrikeSummary) {
        generateEodStrikeAnalysis();
      }
    }
  }

  // ── EOD ATM ±400 Strike Analysis (100pt intervals, cross-referenced with participant data) ──
  const EOD_STRIKE_SUMMARY_FILE = path.join(process.cwd(), "data", "eod-strike-summary.json");

  function loadEodStrikeSummary(): any[] {
    try { return JSON.parse(fs.readFileSync(EOD_STRIKE_SUMMARY_FILE, "utf-8")); } catch { return []; }
  }

  async function generateEodStrikeAnalysis(): Promise<void> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) { console.warn("[eod-strike] DEEPSEEK_API_KEY not set"); return; }

    const today = getISTDateStr(new Date());

    // Get ATM from OC snapshot
    const ocSnaps = loadOcSnapshots();
    const todayOc = ocSnaps.find(s => s.date === today) || ocSnaps[ocSnaps.length - 1];
    if (!todayOc) { console.warn("[eod-strike] no OC snapshot available"); return; }

    const niftySpot = todayOc.niftySpot;
    // ATM rounded to nearest 100 (100pt intervals only, per user requirement)
    const atm = Math.round(niftySpot / 100) * 100;

    // Build the 9 target strikes: ATM-400 to ATM+400 in 100pt steps
    const targetStrikes: number[] = [];
    for (let d = -400; d <= 400; d += 100) targetStrikes.push(atm + d);

    // Per-strike intraday summary from 3-min timeline
    const strikeSummaries: string[] = [];
    for (const strike of targetStrikes) {
      const dist = strike - atm;
      const distLabel = dist === 0 ? "ATM" : dist > 0 ? `ATM+${dist}` : `ATM${dist}`;
      const bars: any[] = timelineStore.get(strike) || [];
      const dayBars = barsForISTDate(bars, today);

      if (dayBars.length < 2) {
        strikeSummaries.push(`${strike} (${distLabel}): No intraday data captured.`);
        continue;
      }

      const first = dayBars[0];
      const last  = dayBars[dayBars.length - 1];

      // Total COI across all bars for the day
      const totalCallCOI = dayBars.reduce((s, b) => s + (Number(b.call?.coi) || 0), 0);
      const totalPutCOI  = dayBars.reduce((s, b) => s + (Number(b.put?.coi)  || 0), 0);
      const callLtpChg   = (Number(last.call?.ltp) || 0) - (Number(first.call?.ltp) || 0);
      const putLtpChg    = (Number(last.put?.ltp)  || 0) - (Number(first.put?.ltp)  || 0);

      const callAct = totalCallCOI > 1000
        ? (callLtpChg <= 0 ? "Call Writing (ceil)" : "Call Buying (bull)")
        : totalCallCOI < -1000 ? "Call Short-Covering"
        : "Neutral";
      const putAct  = totalPutCOI > 1000
        ? (putLtpChg <= 0 ? "Put Writing (floor)" : "Put Buying (bear/hedge)")
        : totalPutCOI < -1000 ? "Put Short-Covering"
        : "Neutral";

      const cOpen = Number(first.call?.ltp)?.toFixed(1) ?? "?";
      const cClose = Number(last.call?.ltp)?.toFixed(1) ?? "?";
      const pOpen  = Number(first.put?.ltp)?.toFixed(1)  ?? "?";
      const pClose = Number(last.put?.ltp)?.toFixed(1)   ?? "?";
      const cOiK = (totalCallCOI / 1000).toFixed(1);
      const pOiK = (totalPutCOI / 1000).toFixed(1);

      strikeSummaries.push(
        `${strike} (${distLabel}): CE=[OI Δ${totalCallCOI > 0 ? "+" : ""}${cOiK}K, LTP ₹${cOpen}→₹${cClose}, ${callAct}] | PE=[OI Δ${totalPutCOI > 0 ? "+" : ""}${pOiK}K, LTP ₹${pOpen}→₹${pClose}, ${putAct}]`
      );
    }

    // Today's participant data
    const snapshots  = loadHistoricalOI();
    const todaySnap  = snapshots.find(s => s.date === today) || snapshots[snapshots.length - 1];
    let partSummary  = "Not available for today.";
    if (todaySnap?.participants?.length) {
      const n = (p: any) => `Net ${(p.callLong - p.callShort) >= 0 ? "Long" : "Short"} ${Math.abs(p.callLong - p.callShort).toLocaleString("en-IN")}`;
      const f = (p: any) => `Net ${(p.idxFutLong - p.idxFutShort) >= 0 ? "Long" : "Short"} ${Math.abs(p.idxFutLong - p.idxFutShort).toLocaleString("en-IN")}`;
      const rows = todaySnap.participants.map(p =>
        `${p.name}: IdxFut=${f(p)}, Calls=${n(p)}, Puts=Net ${(p.putLong - p.putShort) >= 0 ? "Long" : "Short"} ${Math.abs(p.putLong - p.putShort).toLocaleString("en-IN")}`
      );
      partSummary = rows.join("\n");
    }

    const userPrompt = `Today is ${today}. Nifty spot ≈ ${Math.round(niftySpot)}, ATM = ${atm}.

## TODAY'S EOD PARTICIPANT DATA (who did what in aggregate):
${partSummary}

## ATM ±400 INTRADAY STRIKE ACTIVITY (100pt intervals, today's 3-min data):
${strikeSummaries.join("\n")}

KEY INTERPRETATION RULES:
- Call Writing (OI +, premium fell) = someone SOLD calls there = resistance/ceiling
- Put Writing (OI +, premium fell) = someone SOLD puts there = support/floor
- Call Buying (OI +, premium rose) = bullish directional bet
- Put Buying (OI +, premium rose) = bearish directional bet or protection
- FIIs net short calls → they are call writers → match to CE Writing strikes
- FIIs net long puts → they bought puts → match to PE Buying strikes
- PROs often do opposite of FIIs
- These 9 strikes (ATM±400) cover all the real money action for today

TASK: Write a crisp, plain-English strike-by-strike summary. For each strike, say what dominant activity happened and which participant type most likely drove it. End with a 2-sentence overall market narrative.

Output ONLY this JSON:
{
  "date": "${today}",
  "niftySpot": ${Math.round(niftySpot)},
  "atm": ${atm},
  "generatedAt": "${new Date().toISOString()}",
  "overallNarrative": "2-3 sentences plain English: what smart money did today at the key strikes, and what it signals for tomorrow.",
  "strikes": [
    {
      "strike": ${atm},
      "label": "ATM",
      "callActivity": "Call Writing",
      "putActivity": "Put Writing",
      "likelyParticipant": "FIIs",
      "whatHappened": "Under 25 words: what happened at this strike today and what it means.",
      "significance": "HIGH"
    }
  ]
}`;

    try {
      console.log("[eod-strike] calling DeepSeek for ATM±400 strike summary…");
      const resp = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat", // faster + cheaper than R1 for this structured task
          messages: [
            { role: "system", content: "You are an NSE options analyst. Output ONLY valid JSON — no markdown fences, no extra text." },
            { role: "user",   content: userPrompt },
          ],
          max_tokens: 2500,
          temperature: 0.2,
        },
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 60000 }
      );

      const content = resp.data?.choices?.[0]?.message?.content ?? "";
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) { console.error("[eod-strike] JSON parse failed. Raw:", content.slice(0, 300)); return; }

      const parsed = JSON.parse(m[0]);

      // Append to rolling history (keep 30 days)
      const history = loadEodStrikeSummary();
      const updated = history.filter((x: any) => x.date !== today);
      updated.push(parsed);
      while (updated.length > 30) updated.shift();
      fs.mkdirSync(path.dirname(EOD_STRIKE_SUMMARY_FILE), { recursive: true });
      fs.writeFileSync(EOD_STRIKE_SUMMARY_FILE, JSON.stringify(updated));
      console.log(`[eod-strike] ✓ Saved strike summary for ${today}: ${parsed.strikes?.length} strikes`);
    } catch (e: any) {
      console.error("[eod-strike] DeepSeek error:", e.response?.data?.error?.message || e.message);
    }
  }


  
  // ── API: EOD Analysis ─────────────────────────────────────────────────────────

  // GET /api/ai/eod-analysis — latest analysis + 7-day history
  app.get("/api/ai/eod-analysis", (_req, res) => {
    const memory = loadAiMemory();
    if (memory.length === 0) {
      return res.status(404).json({
        error: "No analysis yet. Auto-generates at 3:45 PM IST after market closes. You can also trigger it manually.",
      });
    }
    res.json({ latest: memory[memory.length - 1], history: memory.slice(-7) });
  });

  // POST /api/ai/eod-analysis — trigger manually
  app.post("/api/ai/eod-analysis", async (_req, res) => {
    if (!process.env.DEEPSEEK_API_KEY)
      return res.status(503).json({ error: "DEEPSEEK_API_KEY not configured in environment." });
    const hist = loadHistoricalOI();
    if (hist.length < 1)
      return res.status(400).json({ error: "No participant data yet. Visit the EOD Participants tab first to auto-fetch today's NSE data." });
    res.json({ message: "Analysis triggered. DeepSeek R1 is reasoning… ready in ~60–90 seconds. Refresh this page." });
    generateEodAnalysis(true); // fire-and-forget
  });

  // ── API: EOD Strike Summary (ATM ±400, 100pt intervals) ─────────────────────

  // GET /api/ai/eod-strike-summary
  app.get("/api/ai/eod-strike-summary", (_req, res) => {
    const history = loadEodStrikeSummary();
    if (history.length === 0)
      return res.status(404).json({ error: "No strike summary yet. Auto-generates at 3:45 PM IST after market closes." });
    res.json({ latest: history[history.length - 1], history: history.slice(-7) });
  });

  // POST /api/ai/eod-strike-summary — manually trigger
  app.post("/api/ai/eod-strike-summary", async (_req, res) => {
    if (!process.env.DEEPSEEK_API_KEY)
      return res.status(503).json({ error: "DEEPSEEK_API_KEY not configured." });
    const ocSnaps = loadOcSnapshots();
    if (ocSnaps.length === 0)
      return res.status(400).json({ error: "No OC snapshot yet — take snapshot first (POST /api/ai/oc-snapshot)." });
    res.json({ message: "Strike analysis triggered. Ready in ~30 seconds." });
    generateEodStrikeAnalysis(); // fire-and-forget
  });

  // POST /api/ai/oc-snapshot — manually trigger OC snapshot (for testing)
  app.post("/api/ai/oc-snapshot", async (_req, res) => {
    if (!activeToken || activeToken === "YOUR_UPSTOX_API_TOKEN")
      return res.status(503).json({ error: "No Upstox token — login first to take a snapshot." });
    res.json({ message: "Taking OC snapshot now…" });
    takeOcSnapshot(activeToken).then(() => updateWatchlistPremiums());
  });

  // GET /api/ai/watchlist — all active strike predictions with premium history
  app.get("/api/ai/watchlist", (_req, res) => {
    const memory = loadAiMemory();
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const entries = memory
      .filter(m => new Date(m.date) >= cutoff)
      .flatMap(m => m.watchlist.map(w => ({ ...w, analysisDate: m.date })));
    res.json({ entries });
  });

  // ── POST /api/ai/chat — DeepSeek streaming chat with full dashboard context ──
  // Body: { messages: [{role, content}[], contextFlags: {eod?, timeline?, chain?, memory?} }
  // Streams SSE: data: {"t":"token"}\n\n  then  data: [DONE]\n\n
  app.post("/api/ai/chat", async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "DEEPSEEK_API_KEY not configured" });
      return;
    }

    const { messages = [], contextFlags = {} } = req.body as {
      messages: { role: string; content: string }[];
      contextFlags?: { eod?: boolean; timeline?: boolean; chain?: boolean; memory?: boolean };
    };

    // ── Build context sections based on what the user enabled ────────────────
    const contextParts: string[] = [];

    // 1. EOD Participant Data (last 7 days)
    if (contextFlags.eod !== false) {
      const hist = loadHistoricalOI();
      if (hist.length > 0) {
        const recent = hist.slice(-7);
        const rows = recent.map(s => {
          const fii = s.participants?.find((p: any) => p.name?.includes("FII") || p.name?.includes("Foreign"));
          const pro = s.participants?.find((p: any) => p.name?.includes("Pro"));
          const dii = s.participants?.find((p: any) => p.name?.includes("DII") || p.name?.includes("Domestic"));
          const fmt = (x: any) => (x == null ? "n/a" : Number(x).toLocaleString("en-IN"));
          return `  ${s.date} | FII: Fut=${fmt(fii?.idxFutLong)}-${fmt(fii?.idxFutShort)} CL=${fmt(fii?.callLong)}-${fmt(fii?.callShort)} PL=${fmt(fii?.putLong)}-${fmt(fii?.putShort)} | PRO: CL=${fmt(pro?.callLong)}-${fmt(pro?.callShort)} PL=${fmt(pro?.putLong)}-${fmt(pro?.putShort)} | DII: CL=${fmt(dii?.callLong)}-${fmt(dii?.callShort)}`;
        }).join("\n");
        contextParts.push(`## EOD PARTICIPANT DATA (last ${recent.length} days)\n${rows}`);
      }
    }

    // 2. 3-Min Strike Timeline (ATM ± 500, last 7 days)
    if (contextFlags.timeline !== false && timelineStore.size > 0) {
      // Find approximate ATM from the most recent bar across all strikes
      let latestTs = 0;
      let atmGuess = 0;
      timelineStore.forEach((bars: any[], strike: number) => {
        const last = bars[bars.length - 1];
        if (last?.isoTimestamp) {
          const t = new Date(last.isoTimestamp).getTime();
          if (t > latestTs) { latestTs = t; atmGuess = strike; }
        }
      });
      // Round ATM to nearest 100
      const roundedAtm = Math.round(atmGuess / 100) * 100;

      // Collect all timeline dates
      const allDates = new Set<string>();
      timelineStore.forEach((bars: any[]) =>
        bars.forEach((b: any) => { if (b.isoTimestamp) allDates.add(getISTDateStr(new Date(b.isoTimestamp))); })
      );
      const tlDates = Array.from(allDates).sort().slice(-7);

      // Per-strike summary across dates
      const strikeRows: string[] = [];
      const strikesInRange: number[] = [];
      timelineStore.forEach((_: any, strike: number) => {
        if (Math.abs(strike - roundedAtm) <= 500) strikesInRange.push(strike);
      });
      strikesInRange.sort((a, b) => a - b);

      for (const strike of strikesInRange) {
        const bars: any[] = timelineStore.get(strike) || [];
        if (bars.length === 0) continue;

        const dayTags: string[] = [];
        for (const date of tlDates) {
          const dayBars = bars.filter((b: any) => b.isoTimestamp && getISTDateStr(new Date(b.isoTimestamp)) === date);
          if (dayBars.length === 0) { dayTags.push("--"); continue; }
          const first = dayBars[0]; const last = dayBars[dayBars.length - 1];
          const cCOI = (last.call?.coi ?? 0) - (first.call?.coi ?? 0);
          const pCOI = (last.put?.coi ?? 0) - (first.put?.coi ?? 0);
          const cDir = (last.call?.ltp ?? 0) - (first.call?.ltp ?? 0);
          const pDir = (last.put?.ltp ?? 0) - (first.put?.ltp ?? 0);
          const cAct = cCOI > 300 ? (cDir <= 0 ? "CW" : "CB") : cCOI < -300 ? "CU" : "-";
          const pAct = pCOI > 300 ? (pDir <= 0 ? "PW" : "PB") : pCOI < -300 ? "PU" : "-";
          dayTags.push(`${cAct}/${pAct}`);
        }

        // Last known premiums
        const lastBar = bars[bars.length - 1];
        const cltp = lastBar.call?.ltp?.toFixed(1) ?? "?";
        const pltp = lastBar.put?.ltp?.toFixed(1) ?? "?";
        strikeRows.push(`  ${strike} | CE₹${cltp} PE₹${pltp} | ${dayTags.join(" | ")}`);
      }

      if (strikeRows.length > 0) {
        const header = `  Strike | Last Premiums | ${tlDates.join(" | ")}`;
        contextParts.push(`## 3-MIN TIMELINE (ATM~${roundedAtm} ± 500, Tags: CW=CallWrite CB=CallBuy CW=CallUnwind PW=PutWrite PB=PutBuy PU=PutUnwind)\n${header}\n${strikeRows.join("\n")}`);
      }
    }

    // 3. OC Snapshot (latest)
    if (contextFlags.chain !== false) {
      const snaps = loadOcSnapshots();
      if (snaps.length > 0) {
        const latest = snaps[snaps.length - 1];
        const topRows = latest.niftyStrikes.slice(0, 20).map((s) =>
          `  ${s.strike} CE:OI=${s.callOI} LTP=${s.callLTP} | PE:OI=${s.putOI} LTP=${s.putLTP}`
        ).join("\n");
        contextParts.push(`## OPTION CHAIN SNAPSHOT (${latest.date})\n${topRows}`);
      }
    }

    // 4. AI Memory (last 5 analyses)
    if (contextFlags.memory !== false) {
      const memory = loadAiMemory();
      if (memory.length > 0) {
        const recent = memory.slice(-5);
        const summaries = recent.map(m =>
          `  [${m.date}] Narrative: ${m.narrative?.slice(0, 200) ?? "n/a"}...`
        ).join("\n");
        contextParts.push(`## AI MEMORY (last ${recent.length} analyses)\n${summaries}`);
      }
    }

    // ── Detect specific strikes mentioned by user — add their full timeline ──
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    const mentionedStrikes = [...new Set(
      (lastUserMsg.match(/\b(1[5-9]\d{3}|2[0-9]\d{3})\b/g) || []).map(Number)
    )].slice(0, 5); // up to 5 specific strikes

    if (mentionedStrikes.length > 0 && contextFlags.timeline !== false) {
      const strikeParts: string[] = [];
      for (const strike of mentionedStrikes) {
        const bars: any[] = timelineStore.get(strike) || [];
        if (bars.length === 0) { strikeParts.push(`${strike}: No data in timeline store.`); continue; }
        // Last 7 trading days
        const allDates = new Set<string>();
        bars.forEach(b => { if (b.isoTimestamp) allDates.add(getISTDateStr(new Date(b.isoTimestamp))); });
        const dates = Array.from(allDates).sort().slice(-7);
        const rows: string[] = [];
        for (const date of dates) {
          const db = bars.filter(b => b.isoTimestamp && getISTDateStr(new Date(b.isoTimestamp)) === date);
          if (db.length === 0) continue;
          const first = db[0]; const last = db[db.length - 1];
          const totalCCOI = db.reduce((s, b) => s + (Number(b.call?.coi) || 0), 0);
          const totalPCOI = db.reduce((s, b) => s + (Number(b.put?.coi)  || 0), 0);
          const cChg = (Number(last.call?.ltp) || 0) - (Number(first.call?.ltp) || 0);
          const pChg = (Number(last.put?.ltp)  || 0) - (Number(first.put?.ltp)  || 0);
          const cAct = totalCCOI > 500 ? (cChg <= 0 ? "CW" : "CB") : totalCCOI < -500 ? "CU" : "-";
          const pAct = totalPCOI > 500 ? (pChg <= 0 ? "PW" : "PB") : totalPCOI < -500 ? "PU" : "-";
          rows.push(`  ${date}: CE OI Δ${totalCCOI > 0 ? "+" : ""}${(totalCCOI/1000).toFixed(1)}K LTP ₹${(Number(first.call?.ltp)||0).toFixed(1)}→₹${(Number(last.call?.ltp)||0).toFixed(1)} [${cAct}] | PE OI Δ${totalPCOI > 0 ? "+" : ""}${(totalPCOI/1000).toFixed(1)}K LTP ₹${(Number(first.put?.ltp)||0).toFixed(1)}→₹${(Number(last.put?.ltp)||0).toFixed(1)} [${pAct}]`);
        }
        strikeParts.push(`Strike ${strike}:\n${rows.join("\n") || "  No bars for recent dates."}`);
      }
      contextParts.push(`## REQUESTED STRIKE TIMELINE (last 7 days)\n${strikeParts.join("\n\n")}`);
    }

    // ── System prompt ────────────────────────────────────────────────────────
    const systemPrompt = `You are OC-Flows AI, an expert NSE options analyst specialising in smart money flow detection.

You have access to the following live dashboard data:
${contextParts.length > 0 ? contextParts.join("\n\n") : "(No context data currently available — ask the user to enable context chips)"}

KEY CONCEPTS:
- FIIs = Foreign Institutional Investors — primary trend setters. Their index futures net is the #1 signal.
- PRO/PropDesk = Proprietary traders — sophisticated, often contrarian. They hedge FIIs.
- DII = Domestic institutions — usually supportive buyers on dips.
- Clients = Retail — usually wrong at extremes (contrarian signal).
- CW = Call Writing (OI up + premium fell = sold calls = resistance ceiling built)
- CB = Call Buying (OI up + premium rose = bullish directional bet)
- PW = Put Writing (OI up + premium fell = sold puts = support floor built)
- PB = Put Buying (OI up + premium rose = bearish/hedge)
- CU/PU = Unwinding (OI fell = exiting position = watch for breakout)

FII OPTION BEHAVIOR (critical):
- FIIs do directional option trades at ATM or ITM (within ±300 of spot) only
- Far OTM (>300 from spot) = hedging, not directional intent
- FIIs net short calls + CE Writing at ATM/slight OTM = strong resistance they will defend
- FIIs net long puts at ATM = downside protection on their futures longs
- When FIIs net long futures but also net long puts = they expect a rally but are hedged

Be direct, concise, plain English. Use bullet points. Reference actual numbers from the data.`;

    // ── Build message list for DeepSeek ─────────────────────────────────────
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    // ── Stream response via SSE ───────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const dsRes = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: chatMessages,
          stream: true,
          max_tokens: 2048,
          temperature: 0.7,
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          responseType: "stream",
          timeout: 120000,
        }
      );

      let buf = "";
      dsRes.data.on("data", (chunk: any) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6).trim();
          if (payload === "[DONE]") {
            res.write("data: [DONE]\n\n");
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              res.write(`data: ${JSON.stringify({ t: token })}\n\n`);
            }
          } catch (e: any) {
            console.error("[ai/chat] SSE parse error:", payload.slice(0, 80), e.message);
          }
        }
      });

      dsRes.data.on("end", () => {
        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

      dsRes.data.on("error", (err: Error) => {
        console.error("[ai/chat] stream error:", err.message);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

      // Clean up on client disconnect
      req.on("close", () => { dsRes.data.destroy(); });

    } catch (e: any) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error("[ai/chat] DeepSeek error:", msg);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: `DeepSeek error: ${msg}` })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  scheduleEodAnalysis();

  // ══════════════════════════════════════════════════════════════════════════════
  // FLOW INTELLIGENCE ENGINE — Storage, State, APIs
  // ══════════════════════════════════════════════════════════════════════════════

  // ── File paths ───────────────────────────────────────────────────────────────
  const FLOW_EVENTS_DIR     = path.join(process.cwd(), "data", "flow-events");
  const REGIME_HISTORY_FILE = path.join(process.cwd(), "data", "regime-history.json");
  const WALL_HISTORY_FILE   = path.join(process.cwd(), "data", "wall-history.json");
  const NOTEBOOKS_FILE      = path.join(process.cwd(), "data", "notebooks.json");
  const MOVE_LOG_FILE       = path.join(process.cwd(), "data", "move-log.json");
  const PATTERN_MEMORY_FILE = path.join(process.cwd(), "data", "pattern-memory.json");
  const SESSION_SIGS_FILE   = path.join(process.cwd(), "data", "session-signatures.json");

  if (!fs.existsSync(FLOW_EVENTS_DIR)) fs.mkdirSync(FLOW_EVENTS_DIR, { recursive: true });

  // ── Persistent readers / writers ─────────────────────────────────────────────
  function readJson<T>(file: string, fallback: T): T {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
  }
  function writeJson(file: string, data: any) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch {}
  }

  function loadFlowEvents(date: string): FlowEvent[] {
    return readJson<FlowEvent[]>(path.join(FLOW_EVENTS_DIR, `events-${date}.json`), []);
  }
  function saveFlowEvents(date: string, events: FlowEvent[]) {
    writeJson(path.join(FLOW_EVENTS_DIR, `events-${date}.json`), events);
  }
  function loadRegimeHistory(): RegimeSummary[] {
    return readJson<RegimeSummary[]>(REGIME_HISTORY_FILE, []);
  }
  function loadWallHistory(): WallState[] {
    return readJson<WallState[]>(WALL_HISTORY_FILE, []);
  }
  function loadNotebooks(): NotebookEntry[] {
    return readJson<NotebookEntry[]>(NOTEBOOKS_FILE, []);
  }
  function loadMoveLog(): MoveInstance[] {
    return readJson<MoveInstance[]>(MOVE_LOG_FILE, []);
  }
  function loadPatternMemory(): PrecursorPattern[] {
    return readJson<PrecursorPattern[]>(PATTERN_MEMORY_FILE, []);
  }
  function loadSessionSignatures(): SessionSignature[] {
    return readJson<SessionSignature[]>(SESSION_SIGS_FILE, []);
  }

  // ── In-memory flow state (updated every engine run) ──────────────────────────
  let currentRegime: RegimeSummary | null = null;
  let currentWalls:  WallState | null     = null;
  let currentNotebook: NotebookEntry | null = null;
  let currentAnomalies: AnomalyEntry[] = [];
  let lastFlowRunAt = 0;

  // ── Expiry utility ───────────────────────────────────────────────────────────
  function getDaysToExpiry(): number {
    if (!cachedExpiry) return 7;
    return Math.ceil((new Date(cachedExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  function computeMaxPainStrike(): number | null {
    if (!cachedExpiry) return null;
    let bestStrike: number | null = null;
    let minPain = Infinity;
    timelineStore.forEach((bars, strike) => {
      if (bars.length === 0) return;
      const callOi = bars[0].call?.oi ?? 0;
      const putOi  = bars[0].put?.oi  ?? 0;
      const pain   = callOi + putOi; // simplified max-pain proxy
      if (pain < minPain) { minPain = pain; bestStrike = strike; }
    });
    return bestStrike;
  }

  // ── CORE ENGINE RUN ──────────────────────────────────────────────────────────
  // Called after each capture cycle (every 60s during market hours).
  // Also callable manually via POST /api/flow/analyze.
  async function runFlowEngine(): Promise<void> {
    if (timelineStore.size === 0) return;
    const now = Date.now();
    if (now - lastFlowRunAt < 55_000) return; // rate-limit: don't run more than once/min
    lastFlowRunAt = now;

    const today = getISTDateStr(new Date());
    const spot   = getCurrentSpot();
    if (spot <= 0) return;

    // 1. Compute per-strike features
    const allFeatures = computeAllFeatures(timelineStore, spot, 700);
    if (allFeatures.size === 0) return;

    // 2. Detect events for each strike
    const daysToExpiry   = getDaysToExpiry();
    const maxPainStrike  = computeMaxPainStrike();
    const existingEvents = loadFlowEvents(today);
    const newEvents: FlowEvent[] = [];

    const ctx: EventDetectionContext = {
      allFeatures,
      spot,
      maxPainStrike,
      daysToExpiry,
      date: today,
    };

    allFeatures.forEach((features, strike) => {
      const bars = timelineStore.get(strike) ?? [];
      const detected = detectEventsForStrike(features, bars, ctx);
      for (const evt of detected) {
        // Only add if not already stored (dedup by id)
        if (!existingEvents.some(e => e.id === evt.id)) {
          newEvents.push(evt);
        }
      }
    });

    // Persist new events
    if (newEvents.length > 0) {
      const merged = [...newEvents, ...existingEvents];
      // Keep last 500 events for today
      const pruned = merged.slice(0, 500);
      saveFlowEvents(today, pruned);
    }

    const allTodayEvents = newEvents.length > 0
      ? [...newEvents, ...existingEvents].slice(0, 500)
      : existingEvents;

    // 3. Detect walls
    const newWalls = detectWalls(timelineStore, spot, currentWalls ?? undefined);
    currentWalls = newWalls;

    // Add wall migration events if any
    for (const migration of newWalls.recentMigrations.slice(0, 1)) {
      const migEvt = wallMigrationToEvent(migration, today);
      if (!allTodayEvents.some(e => e.id === migEvt.id)) {
        allTodayEvents.unshift(migEvt);
      }
    }

    // 4. Classify regime
    const priorRegime = currentRegime ?? undefined;
    const regime = classifyRegime(allTodayEvents, allFeatures, spot, today, priorRegime);
    currentRegime = regime;

    // 5. Generate notebook (every 5 min)
    if (!currentNotebook || now - new Date(currentNotebook.generatedAt).getTime() > 5 * 60 * 1000) {
      currentNotebook = generateNotebook(regime, newWalls, allTodayEvents, spot, today);
    }

    // 6. Compute anomalies
    currentAnomalies = computeAnomalies(allFeatures, allTodayEvents);

    // 7. Persist regime + walls + notebook (every 5 min)
    if (!priorRegime || now - new Date(priorRegime.computedAt).getTime() > 5 * 60 * 1000) {
      const regimeHistory = loadRegimeHistory();
      regimeHistory.unshift(regime);
      writeJson(REGIME_HISTORY_FILE, regimeHistory.slice(0, 90 * 8)); // 90 days × ~8 runs

      const wallHistory = loadWallHistory();
      wallHistory.unshift(newWalls);
      writeJson(WALL_HISTORY_FILE, wallHistory.slice(0, 300));

      if (currentNotebook) {
        const notebooks = loadNotebooks();
        notebooks.unshift(currentNotebook);
        writeJson(NOTEBOOKS_FILE, notebooks.slice(0, 60));
      }
    }
  }

  // ── MOVE DETECTION ENGINE (every 15 min) ─────────────────────────────────────
  let lastMoveRunAt = 0;

  async function runMoveEngine(): Promise<void> {
    const now = Date.now();
    if (now - lastMoveRunAt < 14 * 60 * 1000) return;
    lastMoveRunAt = now;

    if (timelineStore.size === 0) return;
    const spot  = getCurrentSpot();
    const today = getISTDateStr(new Date());
    if (spot <= 0) return;

    const spotBars    = extractSpotHistory(timelineStore);
    const largeMoves  = detectLargeMoves(spotBars);
    if (largeMoves.length === 0) return;

    const allTodayEvents   = loadFlowEvents(today);
    const allFeatures      = computeAllFeatures(timelineStore, spot);
    const existingMoveLog  = loadMoveLog();

    for (const rawMove of largeMoves.slice(0, 3)) {
      const moveId = `${rawMove.startTs.slice(0, 13)}_${rawMove.direction}`;
      if (existingMoveLog.some(m => `${m.startTs.slice(0, 13)}_${m.direction}` === moveId)) continue;

      const inferredStart  = inferMoveStart(rawMove, spotBars, allTodayEvents, allFeatures);
      const preMoveWindows = extractPreMoveWindows(inferredStart, allTodayEvents, allFeatures, spotBars, spot);

      const wallNote = currentWalls
        ? `Call wall: ${currentWalls.callWall?.strike ?? "n/a"}, Put wall: ${currentWalls.putWall?.strike ?? "n/a"}. ${currentWalls.recentMigrations.length > 0 ? "Wall migrated before move." : "Walls stable."}`
        : "No wall data available.";
      const ivNote = currentRegime ? `IV trend: ${currentRegime.ivTrend}.` : "IV data unavailable.";

      const moveInstance = buildMoveInstance(rawMove, inferredStart, preMoveWindows, allTodayEvents, wallNote, ivNote, today);
      existingMoveLog.unshift(moveInstance);

      // Create pattern from this move
      if (currentRegime && currentWalls) {
        const featureVector = buildFeatureVector(allFeatures, currentRegime, currentWalls, allTodayEvents, spot);
        const pattern = createPatternFromMove(moveInstance, featureVector, wallNote, ivNote);
        const patterns = loadPatternMemory();
        patterns.unshift(pattern);
        writeJson(PATTERN_MEMORY_FILE, prunePatterns(patterns));
      }
    }

    writeJson(MOVE_LOG_FILE, existingMoveLog.slice(0, 100));
  }

  // ── Get current spot (from most recent bar in timelineStore) ──────────────────
  function getCurrentSpot(): number {
    let latestTs = "";
    let spot = 0;
    timelineStore.forEach(bars => {
      if (bars.length > 0 && (bars[0].isoTimestamp ?? "") > latestTs) {
        latestTs = bars[0].isoTimestamp ?? "";
        spot = parseFloat(bars[0].spot ?? "0") || 0;
      }
    });
    return spot;
  }

  // ── Hook into captureAllStrikes — run engine after each capture ───────────────
  // We patch the post-capture logic by scheduling an engine run after each interval
  setInterval(async () => {
    if (!isMarketOpen()) return;
    try { await runFlowEngine(); } catch (e: any) { console.error("[flow-engine]", e.message); }
  }, 65_000); // slightly offset from 60s capture

  setInterval(async () => {
    if (!isMarketOpen()) return;
    try { await runMoveEngine(); } catch (e: any) { console.error("[move-engine]", e.message); }
  }, 15 * 60 * 1000);

  // ── EOD session signature + similar-day computation ──────────────────────────
  // Runs daily at 3:40 PM IST (alongside EOD analysis)
  function scheduleFlowEod() {
    function msUntil(h: number, m: number): number {
      const now = new Date();
      const target = new Date(now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) + `T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00+05:30`);
      let ms = target.getTime() - now.getTime();
      if (ms < 0) ms += 24 * 60 * 60 * 1000;
      return ms;
    }
    setTimeout(async () => {
      try {
        const today    = getISTDateStr(new Date());
        const spot     = getCurrentSpot();
        const events   = loadFlowEvents(today);
        const moveLog  = loadMoveLog();
        const patterns = loadPatternMemory();
        if (!currentRegime || !currentWalls || spot <= 0) return;

        // Compute session signature
        const sig = computeSessionSignature(today, events, currentRegime, currentWalls, moveLog.filter(m => m.date === today), spot, getDaysToExpiry());
        const sigs = loadSessionSignatures();
        if (!sigs.some(s => s.date === today)) {
          sigs.unshift(sig);
          writeJson(SESSION_SIGS_FILE, sigs.slice(0, 180)); // 180 trading days
        }

        // Update pattern reliability for today's patterns
        const todayMoves = moveLog.filter(m => m.date === today);
        if (todayMoves.length > 0) {
          let updatedPatterns = patterns;
          for (const move of todayMoves) {
            const featureVector = buildFeatureVector(computeAllFeatures(timelineStore, spot), currentRegime, currentWalls, events, spot);
            const matches = findPatternMatches(featureVector, updatedPatterns, 1);
            if (matches.length > 0) {
              updatedPatterns = updatePatternReliability(updatedPatterns, matches[0].pattern.id, move.outcome);
            }
          }
          writeJson(PATTERN_MEMORY_FILE, updatedPatterns);
        }

        console.log("[flow-eod] session signature + pattern update complete for", today);
      } catch (e: any) {
        console.error("[flow-eod]", e.message);
      }
      scheduleFlowEod(); // reschedule for tomorrow
    }, msUntil(15, 40));
  }
  scheduleFlowEod();

  // ── /api/flow/* endpoints ─────────────────────────────────────────────────────

  // GET /api/flow/state — combined current state (regime + walls + events + notebook + anomalies)
  app.get("/api/flow/state", (_req, res) => {
    const today = getISTDateStr(new Date());
    const recentEvents = loadFlowEvents(today).slice(0, 30);
    const state: FlowState = {
      computedAt: new Date().toISOString(),
      regime: currentRegime,
      walls: currentWalls,
      notebook: currentNotebook,
      recentEvents,
      topAnomalies: currentAnomalies,
      livePatternMatch: (() => {
        if (!currentRegime || !currentWalls) return null;
        const spot = getCurrentSpot();
        if (spot <= 0) return null;
        const allFeatures = computeAllFeatures(timelineStore, spot);
        const fv = buildFeatureVector(allFeatures, currentRegime, currentWalls, recentEvents, spot);
        const patterns = loadPatternMemory();
        const matches = findPatternMatches(fv, patterns, 1);
        return matches[0] ?? null;
      })(),
    };
    res.json(state);
  });

  // GET /api/flow/events — events for a specific date
  app.get("/api/flow/events", (req, res) => {
    const date = (req.query.date as string) || getISTDateStr(new Date());
    const events = loadFlowEvents(date);
    const type   = req.query.type as string;
    const strike = req.query.strike ? parseInt(req.query.strike as string) : null;
    const filtered = events
      .filter(e => !type   || e.type   === type)
      .filter(e => !strike || e.strike === strike);
    res.json({ date, total: filtered.length, events: filtered.slice(0, 200) });
  });

  // GET /api/flow/events/live — last N events (cross-date)
  app.get("/api/flow/events/live", (_req, res) => {
    const today = getISTDateStr(new Date());
    const events = loadFlowEvents(today).slice(0, 50);
    res.json({ events });
  });

  // GET /api/flow/anomalies — top anomaly strikes
  app.get("/api/flow/anomalies", (_req, res) => {
    res.json({ anomalies: currentAnomalies });
  });

  // GET /api/flow/walls — current wall state + history
  app.get("/api/flow/walls", (_req, res) => {
    const history = loadWallHistory().slice(0, 20);
    res.json({ current: currentWalls, history });
  });

  // GET /api/flow/regime — current regime + history
  app.get("/api/flow/regime", (_req, res) => {
    const history = loadRegimeHistory().slice(0, 20);
    res.json({ current: currentRegime, history });
  });

  // GET /api/flow/notebook — latest notebook + history
  app.get("/api/flow/notebook", (_req, res) => {
    const history = loadNotebooks().slice(0, 5);
    res.json({ current: currentNotebook, history });
  });

  // GET /api/flow/moves — major move log
  app.get("/api/flow/moves", (_req, res) => {
    const moves = loadMoveLog();
    res.json({ total: moves.length, moves: moves.slice(0, 20) });
  });

  // GET /api/flow/patterns — pattern memory
  app.get("/api/flow/patterns", (_req, res) => {
    const patterns = loadPatternMemory();
    res.json({ total: patterns.length, patterns: patterns.slice(0, 30) });
  });

  // GET /api/flow/pattern-match — live similarity to stored precursor patterns
  app.get("/api/flow/pattern-match", (_req, res) => {
    const spot = getCurrentSpot();
    if (!currentRegime || !currentWalls || spot <= 0) {
      return res.json({ matches: [], reason: "Insufficient data" });
    }
    const today      = getISTDateStr(new Date());
    const events     = loadFlowEvents(today);
    const allFeatures = computeAllFeatures(timelineStore, spot);
    const fv         = buildFeatureVector(allFeatures, currentRegime, currentWalls, events, spot);
    const patterns   = loadPatternMemory();
    const matches    = findPatternMatches(fv, patterns, 3);
    res.json({ matches, featureVector: fv });
  });

  // GET /api/flow/similar-days — top similar historical sessions
  app.get("/api/flow/similar-days", (_req, res) => {
    const spot = getCurrentSpot();
    const today = getISTDateStr(new Date());
    if (!currentRegime || !currentWalls || spot <= 0) {
      return res.json({ similar: [], reason: "Insufficient data" });
    }
    const events = loadFlowEvents(today);
    const moves  = loadMoveLog();
    const sigs   = loadSessionSignatures();
    const daysToExpiry = getDaysToExpiry();
    const current = computeSessionSignature(today, events, currentRegime, currentWalls, moves.filter(m => m.date === today), spot, daysToExpiry);
    const similar = findSimilarDays(current, sigs, 5);
    res.json({ current, similar });
  });

  // GET /api/flow/replay/:date — full event + spot data for a date
  app.get("/api/flow/replay/:date", (req, res) => {
    const date = req.params.date;
    const events = loadFlowEvents(date);
    const regimeHistory = loadRegimeHistory().filter(r => r.date === date);
    const notebooks = loadNotebooks().filter(n => n.date === date);
    res.json({ date, events, regime: regimeHistory[0] ?? null, notebook: notebooks[0] ?? null });
  });

  // POST /api/flow/analyze — manually trigger engine run
  app.post("/api/flow/analyze", async (_req, res) => {
    res.json({ message: "Engine run triggered." });
    lastFlowRunAt = 0; // reset rate limit
    try { await runFlowEngine(); } catch (e: any) { console.error("[flow/analyze]", e.message); }
  });

  // ── Auto-fetch last 7 trading days of NSE EOD participant data ───────────────
  // Runs on startup + available as a manual trigger via POST /api/eod-participants/auto-fetch
  // Source: NSE archives (https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv)
  // Falls back gracefully — if NSE blocks a day, it just skips that day.
  async function autoFetchEodHistory(): Promise<{ fetched: string[]; skipped: string[]; alreadyHad: string[] }> {
    const fetched: string[] = [];
    const skipped: string[] = [];
    const alreadyHad: string[] = [];

    let offset = 0;
    let tradingDaysChecked = 0;
    while (tradingDaysChecked < 7 && offset < 20) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      offset++;
      if (isWeekend(d)) continue;
      tradingDaysChecked++;

      const isoDate = getISTDateStr(d);
      const existing = loadHistoricalOI();
      if (existing.some(s => s.date === isoDate)) {
        alreadyHad.push(isoDate);
        continue;
      }
      const rows = await fetchNseParticipantOI(d);
      if (rows && rows.length > 0) {
        const hist = loadHistoricalOI(); // reload in case another request mutated it
        if (!hist.some(s => s.date === isoDate)) {
          hist.push({
            date: isoDate,
            niftyClose: null,
            participants: rows.map(r => ({ ...r })),
          });
          hist.sort((a, b) => a.date.localeCompare(b.date));
          saveHistoricalOI(hist);
          fetched.push(isoDate);
          console.log(`[auto-fetch] synced ${isoDate} → historical-oi`);
        }
      } else {
        skipped.push(isoDate);
        console.log(`[auto-fetch] skipped ${isoDate} (NSE data not available)`);
      }
    }
    console.log(`[auto-fetch] done. fetched=${fetched.length} alreadyHad=${alreadyHad.length} skipped=${skipped.length}`);
    return { fetched, skipped, alreadyHad };
  }

  // POST /api/eod-participants/auto-fetch — trigger 7-day backfill (also called on startup)
  app.post("/api/eod-participants/auto-fetch", async (_req, res) => {
    res.json({ message: "Fetching last 7 trading days from NSE archives… check server logs." });
    autoFetchEodHistory(); // fire-and-forget
  });

  // GET /api/eod-participants/history-status — how many days are in the store
  app.get("/api/eod-participants/history-status", (_req, res) => {
    const hist = loadHistoricalOI();
    res.json({
      total: hist.length,
      dates: hist.map(s => s.date),
      dateRange: hist.length > 0 ? { from: hist[0].date, to: hist[hist.length - 1].date } : null,
    });
  });

  // On startup: silently try to fill historical-oi with the last 7 trading days
  // (runs after a short delay so the server is fully ready first)
  setTimeout(() => {
    autoFetchEodHistory().catch(e => console.error("[auto-fetch] startup error:", e.message));
  }, 5000);

  // GET /api/charts/:index — 3-min OHLCV + VWAP + cross-strike spurt timestamps
  app.get("/api/charts/:index", async (req, res) => {
    const indexName = req.params.index as "nifty" | "sensex";
    const tok = getConfiguredUpstoxToken();

    if (!tok || tok === "YOUR_UPSTOX_API_TOKEN") {
      return res.json({ bars: [], vwap: [], spurtTimestamps: [], noToken: true });
    }

    const instrKey = indexName === "sensex" ? "BSE_INDEX|SENSEX" : "NSE_INDEX|Nifty 50";
    const encoded  = encodeURIComponent(instrKey);
    const todayIST = getISTDateStr(new Date());
    const fromIST  = getISTDateStr(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));

    let allCandles: any[] = [];
    try {
      const histResp = await axios.get(
        `https://api.upstox.com/v2/historical-candle/${encoded}/1minute/${todayIST}/${fromIST}`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` }, timeout: 20000 }
      );
      allCandles = histResp.data?.data?.candles || [];

      // Merge today's real-time intraday candles when market is open
      if (isMarketOpen()) {
        try {
          const idResp = await axios.get(
            `https://api.upstox.com/v2/historical-candle/intraday/${encoded}/1minute`,
            { headers: { Accept: "application/json", Authorization: `Bearer ${tok}` }, timeout: 10000 }
          );
          allCandles = [...allCandles, ...(idResp.data?.data?.candles || [])];
        } catch {}
      }
    } catch (e: any) {
      console.error(`[charts/${indexName}]`, e.message);
      return res.status(502).json({ bars: [], vwap: [], spurtTimestamps: [], error: e.message });
    }

    let bars = aggregateTo3Min(allCandles);

    // Keep exactly last 7 trading sessions
    const sessionDates = [...new Set(bars.map(b => getISTDateStr(new Date(b.time))))].sort().slice(-7);
    bars = bars.filter(b => sessionDates.includes(getISTDateStr(new Date(b.time))));

    const vwap = computeVwap(bars);

    // Volume spurt timestamps (requires option chain capture data in DB)
    const spot = bars.length > 0 ? bars[bars.length - 1].close : 0;
    const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const spurtDetails = indexName === "nifty"
      ? await detectSpurts(spot, "timeline_bars", 50, 500, cutoffIso)
      : await detectSpurts(spot, "sensex_bars", 500, 2000, cutoffIso);

    res.json({ bars, vwap, spurtDetails });
  });

  // GET /api/option-levels — Max CE OI, Max PE OI, Max Pain for Nifty 50 current weekly expiry
  app.get("/api/option-levels", async (_req, res) => {
    const upstoxToken = getConfiguredUpstoxToken();

    interface ChainRow { strike: number; callOI: number; putOI: number; }
    let chain: ChainRow[] = [];

    if (upstoxToken && upstoxToken !== "YOUR_UPSTOX_API_TOKEN") {
      try {
        const contractsRes = await axios.get(
          "https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX|Nifty%2050",
          { headers: { Accept: "application/json", Authorization: `Bearer ${upstoxToken}` } }
        );
        if (contractsRes.data?.data) {
          const expiriesSet = new Set<string>();
          contractsRes.data.data.forEach((c: any) => { if (c.expiry) expiriesSet.add(c.expiry); });
          const sorted = Array.from(expiriesSet).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
          const weekly = pickWeeklyExpiries(sorted);
          if (weekly.length > 0) {
            const chainRes = await axios.get(
              `https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX|Nifty%2050&expiry_date=${weekly[0]}`,
              { headers: { Accept: "application/json", Authorization: `Bearer ${upstoxToken}` } }
            );
            chain = (chainRes.data.data || [])
              .map((item: any) => ({
                strike: item.strike_price,
                callOI: item.call_options?.market_data?.oi || 0,
                putOI:  item.put_options?.market_data?.oi  || 0,
              }))
              .sort((a: ChainRow, b: ChainRow) => a.strike - b.strike);
          }
        }
      } catch (e: any) {
        console.error("[option-levels] Upstox error:", e.message);
      }
    }

    // Mock fallback
    if (chain.length === 0) {
      const spot = 23200;
      const gauss = (s: number, mu: number, sigma: number) =>
        Math.exp(-((s - mu) ** 2) / (2 * sigma ** 2));
      chain = Array.from({ length: 21 }, (_, i) => spot - 1000 + i * 100).map((s) => ({
        strike: s,
        callOI: Math.floor(2_500_000 * gauss(s, spot + 200, 300) * (0.8 + Math.random() * 0.4)),
        putOI:  Math.floor(2_500_000 * gauss(s, spot - 200, 300) * (0.8 + Math.random() * 0.4)),
      }));
    }

    // Max CE OI strike (resistance)
    const maxCe = chain.reduce((best, c) => (c.callOI > best.callOI ? c : best), chain[0]);
    // Max PE OI strike (support)
    const maxPe = chain.reduce((best, c) => (c.putOI  > best.putOI  ? c : best), chain[0]);

    // Max Pain: strike where total ITM payout to buyers is minimised
    let maxPainStrike = chain[0].strike;
    let minPain = Infinity;
    for (const candidate of chain) {
      let pain = 0;
      for (const row of chain) {
        if (row.strike < candidate.strike) pain += (candidate.strike - row.strike) * row.callOI;
        if (row.strike > candidate.strike) pain += (row.strike - candidate.strike) * row.putOI;
      }
      if (pain < minPain) { minPain = pain; maxPainStrike = candidate.strike; }
    }

    res.json({
      maxCeOI:  { strike: maxCe.strike, oi: maxCe.callOI },
      maxPeOI:  { strike: maxPe.strike, oi: maxPe.putOI  },
      maxPain:  { strike: maxPainStrike },
    });
  });

  // GET /api/market/chart/:symbol — proxy Yahoo Finance v8 for Indian index candles
  app.get("/api/market/chart/:symbol", async (req, res) => {
    const symbol = req.params.symbol; // e.g. ^NSEI
    try {
      const resp = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
        {
          params: { range: "1d", interval: "5m", includePrePost: false },
          headers: { "User-Agent": "Mozilla/5.0 (compatible; QuantDesk/1.0)" },
          timeout: 10000,
        }
      );
      const result = resp.data?.chart?.result?.[0];
      if (!result) return res.json({ candles: [], meta: {} });
      const { timestamp, indicators, meta } = result;
      const quote = indicators.quote[0];
      const candles = (timestamp as number[])
        .map((t, i) => ({
          time: t as number,
          open: quote.open[i] as number,
          high: quote.high[i] as number,
          low: quote.low[i] as number,
          close: quote.close[i] as number,
        }))
        .filter((c) => c.open != null && c.high != null && c.low != null && c.close != null);
      res.json({ candles, meta });
    } catch (e: any) {
      console.error("Yahoo Finance error for", symbol, e.message);
      res.status(500).json({ candles: [], meta: {} });
    }
  });


  // ── API: Manual Export ────────────────────────────────────────────────────────

  app.get("/api/manual-export/last", (_req, res) => {
    const meta = loadManualExportMeta();
    if (!meta) return res.status(404).json({ error: "No export yet" });
    res.json(meta);
  });

  app.post("/api/manual-export/download", async (req, res) => {
    try {
      // Accept an optional `date` in the request body (YYYY-MM-DD, IST).
      // If missing or invalid, fall back to today's IST date so existing
      // callers keep working.
      const rawDate = typeof req.body?.date === "string" ? req.body.date.trim() : "";
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : "";
      if (rawDate && !validDate) {
        return res.status(400).json({ error: "Invalid date format — expected YYYY-MM-DD." });
      }
      // Reject future dates — there's nothing to export for them.
      const todayIst = getISTNowParts().date;
      if (validDate && validDate > todayIst) {
        return res.status(400).json({ error: `Cannot export a future date (${validDate}).` });
      }
      const exportDate = validDate || todayIst;

      const { zipPath, meta } = await buildManualExportZip(exportDate);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${meta.date}.zip"`);
      res.setHeader("x-export-date", meta.date);
      return res.sendFile(zipPath);
    } catch (e: any) {
      console.error("[manual-export] failed:", e.message);
      return res.status(500).json({ error: e.message || "Manual export failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Start background poller — captures all strikes every 60s during market hours
  startBackgroundCapture();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
