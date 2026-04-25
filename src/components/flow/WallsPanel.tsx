import { Shield, ArrowUpRight, ArrowDownRight, ArrowRight, Layers, Clock } from "lucide-react";

interface WallStrike {
  strike: number;
  oi: number;
  concentration: number;
  stabilityBars: number;
  replenished: boolean;
  isRespected: boolean;
}

interface WallMigration {
  timestamp: string;
  fromStrike: number;
  toStrike: number;
  direction: "UP" | "DOWN";
  oiShift: number;
}

interface WallState {
  computedAt: string;
  callWall: WallStrike | null;
  putWall: WallStrike | null;
  secondaryCallWall: WallStrike | null;
  secondaryPutWall: WallStrike | null;
  recentMigrations: WallMigration[];
  wallBand: { callStrike: number; putStrike: number } | null;
  wallWidth: number;
  spotVsWall: "ABOVE_CALL_WALL" | "BELOW_PUT_WALL" | "INSIDE_BAND" | "UNKNOWN";
}

interface WallsPanelProps {
  walls: WallState | null;
  loading: boolean;
}

function WallCard({
  wall,
  type,
}: {
  wall: WallStrike;
  type: "CALL" | "PUT";
}) {
  const isCall = type === "CALL";
  const colorClass = isCall
    ? "border-rose-200 bg-rose-50"
    : "border-emerald-200 bg-emerald-50";
  const labelColor = isCall ? "text-rose-700" : "text-emerald-700";
  const barColor = isCall ? "bg-rose-400" : "bg-emerald-400";

  return (
    <div className={`rounded-xl border p-3 ${colorClass}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${labelColor}`}>
          {isCall ? "Call Wall (Resistance)" : "Put Wall (Support)"}
        </span>
        <div className="flex gap-1">
          {wall.replenished && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700 border border-amber-200">
              Replenishing
            </span>
          )}
          {wall.isRespected && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
              Respected
            </span>
          )}
        </div>
      </div>

      <div className={`text-2xl font-bold tabular-nums ${labelColor} mb-1`}>
        {wall.strike.toLocaleString("en-IN")}
      </div>

      <div className="space-y-1.5 mt-2">
        {/* OI bar */}
        <div>
          <div className="flex justify-between text-[10px] text-slate-500 mb-0.5">
            <span>OI Concentration</span>
            <span className="font-bold">{(wall.concentration * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-white/60 rounded-full overflow-hidden border border-white/80">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${Math.min(100, wall.concentration * 300)}%` }}
            />
          </div>
        </div>

        {/* Stability */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500">Stability</span>
          <div className="flex gap-0.5">
            {Array.from({ length: Math.min(8, wall.stabilityBars) }).map((_, i) => (
              <div key={i} className={`w-2 h-2 rounded-sm ${i < wall.stabilityBars ? barColor : "bg-white/60"}`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MigrationItem({ migration }: { migration: WallMigration }) {
  const isUp = migration.direction === "UP";
  const timeStr = new Date(migration.timestamp).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  });
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
        isUp ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
      }`}>
        {isUp ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-bold tabular-nums">{migration.fromStrike.toLocaleString("en-IN")}</span>
          <ArrowRight size={10} className="text-slate-400 shrink-0" />
          <span className="font-bold tabular-nums">{migration.toStrike.toLocaleString("en-IN")}</span>
          {migration.oiShift !== 0 && (
            <span className={`text-[10px] font-medium ${migration.oiShift > 0 ? "text-emerald-600" : "text-rose-600"}`}>
              ({migration.oiShift > 0 ? "+" : ""}{migration.oiShift.toFixed(0)})
            </span>
          )}
        </div>
      </div>
      <span className="text-[10px] text-slate-400 shrink-0">{timeStr}</span>
    </div>
  );
}

export function WallsPanel({ walls, loading }: WallsPanelProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Dominant Walls</span>
        </div>
        <div className="animate-pulse space-y-3">
          <div className="h-24 bg-slate-100 rounded-xl" />
          <div className="h-24 bg-slate-100 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!walls) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Dominant Walls</span>
        </div>
        <p className="text-xs text-slate-400 py-4 text-center">Wall data will appear once option chain loads.</p>
      </div>
    );
  }

  const spotPosLabel =
    walls.spotVsWall === "ABOVE_CALL_WALL" ? { text: "Above Call Wall", cls: "bg-rose-100 text-rose-700" } :
    walls.spotVsWall === "BELOW_PUT_WALL"  ? { text: "Below Put Wall",  cls: "bg-orange-100 text-orange-700" } :
    walls.spotVsWall === "INSIDE_BAND"     ? { text: `Inside Band · ${walls.wallWidth}pt width`, cls: "bg-blue-100 text-blue-700" } :
    null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-blue-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Dominant Walls</span>
        </div>
        {spotPosLabel && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${spotPosLabel.cls}`}>
            {spotPosLabel.text}
          </span>
        )}
      </div>

      {/* Wall cards */}
      <div className="grid grid-cols-1 gap-3 mb-4">
        {walls.callWall && <WallCard wall={walls.callWall} type="CALL" />}
        {walls.putWall  && <WallCard wall={walls.putWall}  type="PUT"  />}
      </div>

      {/* Secondary walls */}
      {(walls.secondaryCallWall || walls.secondaryPutWall) && (
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Secondary Zones</p>
          <div className="flex gap-2 flex-wrap">
            {walls.secondaryCallWall && (
              <span className="text-xs px-2 py-1 rounded-lg bg-rose-50 border border-rose-100 text-rose-600 font-medium">
                CE {walls.secondaryCallWall.strike.toLocaleString("en-IN")} ({(walls.secondaryCallWall.concentration * 100).toFixed(1)}%)
              </span>
            )}
            {walls.secondaryPutWall && (
              <span className="text-xs px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-600 font-medium">
                PE {walls.secondaryPutWall.strike.toLocaleString("en-IN")} ({(walls.secondaryPutWall.concentration * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
      )}

      {/* Migrations */}
      {walls.recentMigrations.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Layers size={11} className="text-slate-400" />
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Wall Migrations</p>
          </div>
          <div>
            {walls.recentMigrations.slice(0, 5).map((m, i) => (
              <MigrationItem key={i} migration={m} />
            ))}
          </div>
        </div>
      )}

      {walls.recentMigrations.length === 0 && (
        <p className="text-[10px] text-slate-400 text-center pt-1">No wall migrations detected yet.</p>
      )}
    </div>
  );
}
