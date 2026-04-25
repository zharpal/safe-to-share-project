import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface SpotPrices {
  nifty: number;
  banknifty: number;
  sensex: number;
  finnifty: number;
}

export function SpotTicker() {
  const [prices, setPrices] = useState<SpotPrices | null>(null);

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch("/api/spot");
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          throw new TypeError("Oops, we haven't got JSON!");
        }
        const data = await res.json();
        setPrices(data);
      } catch (error) {
        console.error("Failed to fetch spot prices:", error);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 3000); // Update every 3 seconds
    return () => clearInterval(interval);
  }, []);

  if (!prices) return <div className="h-12 bg-white/50 animate-pulse border-b border-blue/10" />;

  const indices = [
    { name: "NIFTY", value: prices.nifty },
    { name: "BANKNIFTY", value: prices.banknifty },
    { name: "SENSEX", value: prices.sensex },
    { name: "FINNIFTY", value: prices.finnifty },
  ];

  return (
    <div className="flex items-center justify-between px-6 py-3 bg-white/80 backdrop-blur-sm border-b border-blue/20 overflow-x-auto whitespace-nowrap shadow-sm">
      <div className="flex items-center gap-8">
        {indices.map((idx) => (
          <div key={idx.name} className="flex items-baseline gap-2">
            <span className="text-blue text-xs font-bold tracking-wider">{idx.name}</span>
            <motion.span 
              key={idx.value}
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-dark font-mono text-sm font-bold"
            >
              {idx.value.toFixed(2)}
            </motion.span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <span className="text-emerald-600 text-xs font-bold tracking-wide">LIVE</span>
      </div>
    </div>
  );
}
