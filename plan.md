# QuantDesk → Institutional Flow Intelligence Platform
## Implementation Plan

---

## 1. REPOSITORY AUDIT

### Stack
| Layer | Technology |
|---|---|
| Frontend | React 19, Tailwind CSS 4.1, Recharts 3.8, lightweight-charts 5.1, Framer Motion 12, Lucide React |
| Backend | Express.js 4.21, TypeScript 5.8, tsx (ESM, no compile step) |
| Database | PostgreSQL (via `pg`) — optional. Falls back to JSON files |
| AI | DeepSeek R1 (`deepseek-reasoner`) for EOD analysis, DeepSeek Chat for streaming |
| Data Source | Upstox API v2 (option chain, futures, historical candles, spot prices) |
| Runtime | Node.js 20+, Railway deployment |

### Current Architecture
```
server.ts  (2989 lines, monolithic)
├── PostgreSQL / JSON storage layer
├── Background capture loop (every 60s during market hours)
│   ├── captureAllStrikes()   → timelineStore + live_bars
│   ├── captureFutures()      → futuresBars
│   └── captureSensexStrikes() → sensexStore
├── Smart money reading (Nitin Bhatia 4-state model)
├── EOD analysis scheduler (3:30 PM + 3:45 PM IST)
├── DeepSeek R1 EOD analysis engine
├── NSE archive auto-fetch
└── 30+ REST API endpoints

src/
├── App.tsx        — 7-tab shell, auth, settings modal
├── components/
│   ├── StrikeTimeline.tsx     — 3-min bars, 7-day history
│   ├── WsTimeline.tsx         — 1-min live feed
│   ├── SensexTimeline.tsx     — BSE Sensex
│   ├── IndicesCharts.tsx      — 3-min OHLCV + VWAP
│   ├── ParticipantData.tsx    — EOD participant matrix
│   ├── OptionChain.tsx        — Current + next week chain
│   ├── SmartMoneyAI.tsx       — DeepSeek EOD analysis UI
│   └── DeepSeekChat.tsx       — Floating streaming chat
```

### Key Data Shapes
```typescript
// Bar stored in timelineStore (Map<strike, bar[]>), newest-first
{
  isoTimestamp: string,
  spot: string,            // "24125.60" — parse to number
  call: {
    oi: number, coi: number, volDelta: number,
    coiVolRatio: string,   // "12.34" — parse
    iv: string,            // "14.25" — parse
    ivRoc: string,         // "-0.30" — parse
    ltp: string,           // "85.00" — parse
    premiumRoc: string,    // "2.50"  — parse
    rawOI: number, rawVol: number
  },
  put: { /* same */ },
  reading: string          // Nitin Bhatia 4-state label
}

// EOD Participant (historical-oi.json)
{
  date: string,            // YYYY-MM-DD
  participants: [{
    name: string,          // "FIIs" | "DIIs" | "PROs" | "Clients"
    idxFutLong, idxFutShort, callLong, callShort,
    putLong, putShort, stkFutLong, stkFutShort: number
  }]
}
```

### Current Risks / Technical Debt
1. `server.ts` is 2989 lines — adding more will make it unmaintainable
2. Timeline bars are newest-first in memory — engine must reverse for chronological analysis
3. String fields (iv, ltp, premiumRoc) require `parseFloat()` before arithmetic
4. No event streaming — frontend polls every 60–180s (acceptable for options flow)
5. No existing test framework

---

## 2. ARCHITECTURE CHANGES

### New Directory Structure
```
engine/                    ← NEW: Backend analytics engine (pure TS, no I/O)
├── types.ts               — All shared interfaces
├── features.ts            — Per-bar feature computation
├── events.ts              — 11 event type detection
├── regime.ts              — Session regime classification
├── walls.ts               — Dominant wall + migration tracking
├── notebook.ts            — Rule-based commentary generator
├── moves.ts               — Large move detection + move-start inference
├── patterns.ts            — Pattern memory (storage + similarity)
└── similarity.ts          — Similar day retrieval (cosine similarity)

data/                      ← NEW JSON storage files
├── flow-events/
│   └── events-{YYYY-MM-DD}.json   — Array<FlowEvent>
├── regime-history.json            — Array<RegimeSummary> (last 90 days)
├── wall-history.json              — Array<WallSnapshot> (last 30 days)
├── notebooks.json                 — Array<NotebookEntry> (last 30 days)
├── move-log.json                  — Array<MoveInstance>
├── pattern-memory.json            — Array<PrecursorPattern>
└── session-signatures.json        — Array<SessionSignature>

src/components/flow/       ← NEW: Flow intelligence UI panels
├── EventTape.tsx           — Scrolling event feed with filters
├── RegimeBox.tsx           — Current regime badge + history
├── WallsPanel.tsx          — Dominant walls + migration
├── AINotebook.tsx          — Rule-based commentary
├── AnomalyHeatmap.tsx      — Strike anomaly grid
├── SimilarDays.tsx         — Similar historical sessions
├── PreMovePanel.tsx        — Move forensics + replay
└── PatternMemory.tsx       — Pattern memory browser

src/components/
└── FlowIntelligence.tsx    ← NEW: Main "Flow Intel" tab
```

### Integration Strategy
- Engine modules are **pure functions** (no I/O) — imported by server.ts
- Analysis runs **after each capture cycle** (post-captureAllStrikes)
- Results stored to JSON files in `data/`
- New `/api/flow/*` endpoints expose results to frontend
- server.ts remains the single entry point (no new processes)

---

## 3. ENGINE MODULES

### 3A. engine/types.ts
All shared TypeScript interfaces:
- `BarFeatures` — per-bar computed analytics (z-scores, acceleration, moneyness, etc.)
- `FlowEvent` — detected event with confidence, explanation, severity
- `RegimeSummary` — session-level regime label + reasoning
- `WallState` — dominant call/put wall with stability score
- `WallMigration` — wall shift event
- `NotebookEntry` — generated commentary
- `MoveInstance` — detected large move with start inference
- `PrecursorPattern` — pre-move feature snapshot + outcome
- `SessionSignature` — session feature vector for similarity search
- `PatternMatch` — live similarity result

### 3B. engine/features.ts
Compute derived analytics from raw bar data:

```
Input: strike, bars[] (last 20), spot
Output: BarFeatures for the most recent bar

Features computed:
- n(), p() helpers to parse string fields
- distFromSpot, moneyness (ATM/NEAR/OTM/FAR_OTM)
- callCoiN, putCoiN (numeric coi)
- callVolN, putVolN (numeric volume)
- callIvN, callIvRocN, callLtpN, callPremRocN (numeric)
- coiAccel = coi[0] - coi[1] (OI change acceleration)
- volAccel, ivAccel, premiumAccel
- rollingMean / rollingStd helpers (last N bars)
- zScoreCOI = (coi - mean) / std
- zScoreVol, zScoreIvRoc, zScorePremiumRoc
- premiumMomentum = sum of last 3 premiumRoc
- coiEfficiency = |coi| / (vol + 1) — how much of volume became net OI
- callPutOiRatio, callPutVolRatio
- sessionBarIndex (which bar of the day this is)
```

### 3C. engine/events.ts
11 event types with confidence scoring:

| Event | Key Logic |
|---|---|
| `FRESH_WRITING` | zScoreCOI > 1.5, premium flat/falling, IV not collapsing |
| `SHORT_COVERING` | zScoreCOI < -1.0, premium rising, velocity check |
| `LONG_BUILDUP` | coi > 0, premium rising, zScore > 1.0 |
| `LONG_UNWINDING` | coi < 0, premium falling, zScore negative |
| `CHURN` | vol high, coiEfficiency < 0.2, no premium follow-through |
| `WALL_CREATION` | OI > P90 across strikes, replenishment pattern |
| `WALL_MIGRATION` | dominant wall shifts between strikes |
| `LIQUIDITY_SWEEP` | vol spike + fast premium reversal within 3 bars |
| `ABSORPTION` | heavy activity but price doesn't move proportionally |
| `IV_SHOCK` | |ivRoc| > 2.5 * historical std |
| `EXPIRY_PIN` | spot near max-pain zone, IV very low, stable OI |

Each event: `{ id, timestamp, strike, type, side, confidence, score, explanation, severity, features }`

### 3D. engine/regime.ts
Session-level classifier:

```
Input: Array<FlowEvent> for today, WallState, spot, priorBars[]
Output: RegimeSummary

Regime labels:
TREND_UP, TREND_DOWN, RANGE_DAY, EXPIRY_PIN,
SHORT_COVERING, LONG_UNWINDING, TRAP_HEAVY,
HIGH_VOL_EVENT, LOW_CONVICTION_CHURN

Logic:
- Count event type distribution
- Measure directional efficiency (call vs put COI net)
- Check wall stability
- Check breadth (% of strikes showing conviction)
- Check IV expansion vs compression
- Apply weighted scoring per regime type
- Pick highest-scoring regime
```

### 3E. engine/walls.ts
```
Input: Map<strike, bars[]>, spot
Output: WallState

WallState {
  callWall: { strike, oi, concentration, stabilityBars, migrationCount }
  putWall:  { ... }
  recentMigrations: WallMigration[]
  wallWidth: number  // point spread of significant OI
  priceRespecting: boolean
}

Logic:
- For each strike, sum total OI (call + put separately)
- Rank by OI → top call wall, top put wall
- Stability = consecutive bars where same strike was dominant
- Migration = when dominant strike changes + spot has moved toward it
```

### 3F. engine/notebook.ts
Rule-based commentary (fully auditable, no LLM required for this layer):

Template-driven sentences mapped to detected conditions:
- Event type + count → narrative sentence
- Wall movement → "The dominant call wall shifted..."
- IV structure → "Implied volatility is expanding/compressing..."
- Regime change → "The session is transitioning from..."
- 3-interval summary → "In the last 9 minutes..."
- Bias meter → BULLISH / BEARISH / NEUTRAL / SPLIT

### 3G. engine/moves.ts
Large move detection + structural start inference:

```
Move detection:
- Collect spot prices from bars across all strikes
- Compute rolling ATR (14-bar)
- Flag moves where |spot[t] - spot[t-N]| > max(ATR * 2.0, MIN_POINTS)
- MIN_POINTS configurable (default: 40 Nifty points in 6 bars = 18 min)

Move-start inference (backward scan):
- From expansion peak, walk backward
- Find first bar where ANY of:
  (a) wall migration started
  (b) IV began shifting abnormally (zScoreIv > 1.5)
  (c) COI efficiency improved (directional clarity emerged)
  (d) Anomaly cluster appeared (3+ strikes showing same event)
  (e) Churn-to-conviction transition

Output: MoveInstance {
  date, direction, startTs, triggerTs, peakTs,
  magnitude, preMoveWindow, outcome
}
```

### 3H. engine/patterns.ts
Pattern memory (stored in `data/pattern-memory.json`):

```typescript
PrecursorPattern {
  id: string
  moveDate: string
  moveDirection: 'UP' | 'DOWN'
  moveMagnitude: number
  moveStartTs: string
  preMoveFeatures: {
    t_minus_30: FeatureSnapshot
    t_minus_15: FeatureSnapshot
    t_minus_6: FeatureSnapshot
    t_minus_3: FeatureSnapshot
  }
  preMoveEventSequence: string[]  // e.g. ["FRESH_WRITING", "WALL_MIGRATION", "IV_SHOCK"]
  dominantStrikes: number[]
  wallBehavior: string
  ivBehavior: string
  outcome: 'SUSTAINED' | 'FAILED' | 'PARTIAL'
  successCount: number
  failureCount: number
  reliabilityScore: number   // successCount / (successCount + failureCount)
  lastSeen: string
  avgMagnitude: number
}

Similarity: cosine distance on feature vectors
  - Normalize each feature to [0, 1]
  - Compute dot product / (|a| * |b|)
  - Return top-3 matches with score

Learning loop:
  After each session:
  1. Check if any stored pattern matched current pre-move state
  2. Observe outcome (did move happen? direction correct?)
  3. Update successCount or failureCount
  4. Recalculate reliabilityScore
  5. Decay patterns not seen in 30+ days
```

### 3I. engine/similarity.ts
Session-level cosine similarity:

```typescript
SessionSignature {
  date: string
  features: {
    oiConcentrationHHI: number     // Herfindahl index of OI distribution
    callPutOiImbalance: number     // net call vs put OI change
    ivExpansionRate: number        // mean IV change across session
    eventMixFreshWriting: number   // fraction of events that are FRESH_WRITING
    eventMixLongBuildup: number
    eventMixChurn: number
    eventMixSweep: number
    wallMigrationCount: number
    breadthScore: number
    directionalEfficiency: number
    sessionVolatility: number
    expiryProximity: number        // days to expiry (normalized)
  }
}

For current session:
1. Compute current session signature from today's events + features
2. Load all stored SessionSignatures
3. Compute cosine similarity for each
4. Return top 5 with score + brief "what happened next" note
```

---

## 4. NEW API ENDPOINTS

All under `/api/flow/`:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/flow/state` | Combined: regime + walls + recent events (last 20) + notebook |
| GET | `/api/flow/events` | Events for `?date=YYYY-MM-DD` (default: today) |
| GET | `/api/flow/events/live` | Last 30 events across all strikes (real-time feed) |
| GET | `/api/flow/anomalies` | Top 10 anomaly strikes ranked by score |
| GET | `/api/flow/walls` | Current wall state + migration history |
| GET | `/api/flow/regime` | Current regime + last 7 days history |
| GET | `/api/flow/notebook` | Latest notebook entry + last 5 |
| GET | `/api/flow/moves` | Major move log (all detected) |
| GET | `/api/flow/patterns` | Pattern memory list |
| GET | `/api/flow/pattern-match` | Current live pattern similarity |
| GET | `/api/flow/similar-days` | Top 5 similar historical sessions |
| GET | `/api/flow/replay/:date` | Full event + bar replay for a date |
| POST | `/api/flow/analyze` | Manually trigger engine re-run |

---

## 5. FRONTEND UI PANELS

### New Tab: "Flow Intel"
Added as the 8th tab in App.tsx.

### Panel Layout (Desktop, 3-column grid):

```
┌─────────────────────────────────────────────────────┐
│  REGIME BOX (full width)                             │
│  Current Regime | Confidence | Why | Trend History   │
└─────────────────────────────────────────────────────┘
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  WALLS PANEL │ │  ANOMALY     │ │  AI NOTEBOOK      │
│  Call Wall   │ │  HEATMAP     │ │  Commentary       │
│  Put Wall    │ │  Top 10      │ │  Bias meter       │
│  Migration   │ │  anomaly     │ │  3-bar summary    │
│  History     │ │  strikes     │ │  Confidence       │
└──────────────┘ └──────────────┘ └──────────────────┘
┌─────────────────────────────────────────────────────┐
│  EVENT TAPE (full width)                             │
│  Time | Strike | Event | Confidence | Explanation   │
│  Filters: All | Writing | Buildup | Sweep | IV      │
└─────────────────────────────────────────────────────┘
┌──────────────────────┐ ┌───────────────────────────┐
│  SIMILAR DAYS        │ │  PRE-MOVE FORENSICS        │
│  Top 3 sessions      │ │  Move log + replay         │
│  Similarity %        │ │  Pattern memory            │
│  What happened next  │ │  Live pattern match        │
└──────────────────────┘ └───────────────────────────┘
```

### Mobile Layout:
Cards stack vertically. Regime Box is pinned at top. Event Tape uses compact rows. Walls Panel uses a 2-column mini grid.

---

## 6. DATA FLOW (after upgrade)

```
Every 60s (market hours):
captureAllStrikes()
  → buildPoint() for each strike
  → appendToHistory()
  → [NEW] runFlowEngineForStrike(strike, bars, spot)
      → computeBarFeatures()
      → detectEventsForStrike()
      → appendFlowEvents()

Every 5 minutes (market hours):
runSessionEngine()
  → detectWalls(timelineStore, spot)
  → classifyRegime(events, features, spot)
  → generateNotebook(regime, walls, events, spot)
  → save regime + walls + notebook to JSON

Every 15 minutes (market hours):
runMoveDetection()
  → detectLargeMove(spotHistory)
  → if move found: inferMoveStart(), extractPrecursor()
  → storeMoveInstance(), updatePatternMemory()

EOD (3:45 PM IST):
runEodEngine()
  → computeSessionSignature()
  → saveSessionSignature()
  → findSimilarDays()
  → updatePatternReliability()
```

---

## 7. IMPLEMENTATION PHASES

### Phase 1 — Foundation (implement NOW)
1. `plan.md` — this file ✓
2. `engine/types.ts` — all interfaces
3. `engine/features.ts` — feature computation
4. `engine/events.ts` — 11 event types
5. `engine/regime.ts` — regime classifier
6. `engine/walls.ts` — wall tracker
7. `engine/notebook.ts` — commentary generator
8. Server integration: post-capture hooks + `/api/flow/*` endpoints
9. Frontend: `FlowIntelligence.tsx` + all panel components
10. App.tsx: add "Flow Intel" tab

### Phase 2 — Learning Loop (implement NOW)
11. `engine/moves.ts` — move detection + start inference
12. `engine/patterns.ts` — pattern memory
13. `engine/similarity.ts` — similar day retrieval
14. Frontend: `PreMovePanel.tsx`, `PatternMemory.tsx`, `SimilarDays.tsx`

### Phase 3 — Polish (optional, future)
- Replay mode with time-stepping
- Confidence calibration
- Per-event explanation popovers
- Downloadable day summary
- Session bookmarks
- Pattern decay / reliability aging
- Telegram alert output
- Adaptive threshold tuning

---

## 8. ALGORITHMS — KEY DESIGN DECISIONS

### Rolling Z-Score
```typescript
function zScore(value: number, history: number[], n = 20): number {
  const window = history.slice(0, n);
  if (window.length < 5) return 0;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const std = Math.sqrt(window.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / window.length);
  return std === 0 ? 0 : (value - mean) / std;
}
```

### Moneyness Classification
```typescript
function moneyness(strike: number, spot: number): "ATM" | "NEAR" | "OTM" | "FAR_OTM" {
  const dist = Math.abs(strike - spot);
  if (dist < 50)  return "ATM";
  if (dist < 150) return "NEAR";
  if (dist < 350) return "OTM";
  return "FAR_OTM";
}
```

### Wall Detection
```typescript
// Aggregate OI across last 5 bars to smooth noise
// Rank strikes by OI → top 3 = "significant wall zone"
// Wall stability = consecutive bars where same strike dominated
// Migration = when top strike changes + prior strike's OI declined
```

### Move-Start Inference (structural break)
```typescript
// NOT: "candle broke above X"
// YES: earliest structural change that preceded move
// Walk backward from peak, score each bar for:
//   - IV regime shift (sudden IV change)
//   - Wall migration start
//   - COI efficiency improvement (directional clarity)
//   - Anomaly cluster (3+ strikes, same direction event)
// First bar scoring > threshold = move start
```

---

## 9. ASSUMPTIONS
1. Spot price comes from `bar.spot` field in each timeline bar (string, parse to float)
2. "ATM" is computed per-bar using the spot price stored in that bar
3. Events are stored per-date in `data/flow-events/events-{date}.json`
4. Pattern memory is capped at 200 patterns (oldest removed)
5. Session signatures retained for 180 days
6. Z-score uses minimum 5 bars (returns 0 if insufficient)
7. "Large move" default threshold: 40 Nifty points in ≤ 6 bars (18 min)
8. Wall stability requires minimum 3 consecutive dominant bars
9. Notebook auto-refreshes every 5 minutes during market hours
10. No PostgreSQL schema changes needed — all new data uses JSON files

---

## 10. FILES CHANGED / CREATED

### New Files
```
plan.md                                    ← this file
engine/types.ts
engine/features.ts
engine/events.ts
engine/regime.ts
engine/walls.ts
engine/notebook.ts
engine/moves.ts
engine/patterns.ts
engine/similarity.ts
src/components/flow/EventTape.tsx
src/components/flow/RegimeBox.tsx
src/components/flow/WallsPanel.tsx
src/components/flow/AINotebook.tsx
src/components/flow/AnomalyHeatmap.tsx
src/components/flow/SimilarDays.tsx
src/components/flow/PreMovePanel.tsx
src/components/flow/PatternMemory.tsx
src/components/FlowIntelligence.tsx
```

### Modified Files
```
server.ts      ← add engine imports, post-capture hooks, /api/flow/* endpoints
src/App.tsx    ← add "Flow Intel" tab
```

### No Changes To
```
All existing components (StrikeTimeline, WsTimeline, etc.)
Database schema (PostgreSQL tables unchanged)
package.json (no new dependencies required)
```
