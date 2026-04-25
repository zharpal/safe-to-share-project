import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";

interface OptionChainData {
  strike: number;
  callOI: number;
  callCOI: number;
  callLTP: string;
  putOI: number;
  putCOI: number;
  putLTP: string;
}

interface ChainResponse {
  currentWeek: OptionChainData[];
  nextWeek: OptionChainData[];
  expiries: { currentWeek: string; nextWeek: string } | null;
}

export function OptionChain() {
  const [data, setData] = useState<ChainResponse | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchData = async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/option-chain");
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new TypeError("Server did not return JSON");
      }
      const resData = await res.json();
      setData(resData);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Failed to fetch option chain:", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Refresh every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  if (!data) return <div className="p-8 text-blue animate-pulse font-bold">Loading Option Chain…</div>;

  const renderChain = (title: string, chain: OptionChainData[], expiry?: string) => {
    const maxCallOI = Math.max(...chain.map((r) => r.callOI));
    const maxCallCOI = Math.max(...chain.map((r) => r.callCOI));
    const maxPutOI = Math.max(...chain.map((r) => r.putOI));
    const maxPutCOI = Math.max(...chain.map((r) => r.putCOI));

    return (
      <div className="bg-white/60 backdrop-blur-sm border border-blue/20 rounded-3xl overflow-hidden shadow-lg flex-1">
        <div className="bg-white px-6 py-5 border-b border-blue/10 flex items-center justify-between">
          <div>
            <h3 className="text-xl font-bold text-dark tracking-tighter uppercase">{title}</h3>
            {expiry && (
              <p className="text-xs text-blue font-bold mt-0.5 tracking-widest uppercase">
                Expiry: {expiry}
              </p>
            )}
          </div>
          <span className="text-xs font-bold font-mono text-blue bg-blue/10 px-3 py-1 rounded-full uppercase tracking-widest">
            Lot: 65
          </span>
        </div>

        <div className="grid grid-cols-7 gap-2 p-4 bg-blue/5 border-b border-blue/10 text-[10px] sm:text-xs font-bold text-dark/60 uppercase tracking-widest">
          <div className="col-span-1 text-right text-emerald-600">Call OI</div>
          <div className="col-span-1 text-right text-emerald-600">Call COI</div>
          <div className="col-span-1 text-right text-emerald-600">Call LTP</div>
          <div className="col-span-1 text-center text-dark bg-blue/10 rounded-md py-1 shadow-inner">Strike</div>
          <div className="col-span-1 text-left text-rose-600">Put LTP</div>
          <div className="col-span-1 text-left text-rose-600">Put COI</div>
          <div className="col-span-1 text-left text-rose-600">Put OI</div>
        </div>

        <div className="divide-y divide-blue/5">
          {chain.map((row, i) => {
            const isMaxCallOI = row.callOI === maxCallOI;
            const isMaxCallCOI = row.callCOI === maxCallCOI;
            const isMaxPutOI = row.putOI === maxPutOI;
            const isMaxPutCOI = row.putCOI === maxPutCOI;

            return (
              <motion.div
                key={row.strike}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="grid grid-cols-7 gap-2 p-3 items-center hover:bg-blue/5 transition-colors font-mono text-xs sm:text-sm"
              >
                <div className={`col-span-1 text-right ${isMaxCallOI ? "text-emerald-700 font-bold bg-emerald-100 px-1 rounded" : "text-dark/80"}`}>
                  {(row.callOI / 100000).toFixed(1)}L
                </div>
                <div className={`col-span-1 text-right ${isMaxCallCOI ? "text-emerald-700 font-bold bg-emerald-100 px-1 rounded" : row.callCOI >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {row.callCOI >= 0 ? "+" : ""}{(row.callCOI / 1000).toFixed(0)}k
                </div>
                <div className="col-span-1 text-right text-emerald-600 font-bold bg-emerald-50 px-2 py-1 rounded">
                  ₹{row.callLTP}
                </div>

                <div className="col-span-1 text-center font-bold text-dark bg-white rounded py-1.5 border border-blue/10 shadow-sm">
                  {row.strike}
                </div>

                <div className="col-span-1 text-left text-rose-600 font-bold bg-rose-50 px-2 py-1 rounded">
                  ₹{row.putLTP}
                </div>
                <div className={`col-span-1 text-left ${isMaxPutCOI ? "text-rose-700 font-bold bg-rose-100 px-1 rounded" : row.putCOI >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {row.putCOI >= 0 ? "+" : ""}{(row.putCOI / 1000).toFixed(0)}k
                </div>
                <div className={`col-span-1 text-left ${isMaxPutOI ? "text-rose-700 font-bold bg-rose-100 px-1 rounded" : "text-dark/80"}`}>
                  {(row.putOI / 100000).toFixed(1)}L
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-dark tracking-tighter uppercase">Nifty Option Chain</h2>
          <p className="text-sm text-blue font-bold mt-1 tracking-widest uppercase">
            Nifty 50 · Lot Size: 65 · Weekly Expiry: Tuesday
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-dark/50 font-mono">
              Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button
            onClick={fetchData}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-blue/20 rounded-xl text-sm font-bold text-blue hover:border-blue/40 transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-col xl:flex-row gap-8">
        {renderChain("Current Week Expiry", data.currentWeek, data.expiries?.currentWeek)}
        {renderChain("Next Week Expiry", data.nextWeek, data.expiries?.nextWeek)}
      </div>
    </div>
  );
}
