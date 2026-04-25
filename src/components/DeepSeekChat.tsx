import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain, X, Send, Maximize2, Minimize2, RefreshCw,
  ChevronDown, Database, Activity, BarChart2, Cpu,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

// ── Suggested prompts shown when chat is empty ────────────────────────────────

const SUGGESTIONS = [
  "Where are FIIs positioned right now?",
  "Which strikes have the heaviest call writing?",
  "What trap is set for tomorrow?",
  "Compare FII vs retail positioning",
  "What does the 3-min OI pattern tell us?",
  "What are the key support & resistance levels?",
];

// ── Context chips — visual only (all context always sent) ─────────────────────

const CONTEXT_CHIPS = [
  { label: "EOD Participants", icon: BarChart2, color: "text-violet-600 bg-violet-50 border-violet-200" },
  { label: "3-Min Timeline",   icon: Activity,  color: "text-blue bg-blue/8 border-blue/20"             },
  { label: "OC Chain",         icon: Database,  color: "text-orange-600 bg-orange-50 border-orange-200" },
  { label: "AI Memory",        icon: Cpu,       color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
];

// ── Markdown-lite renderer (bold, bullet lists) ────────────────────────────────

function RenderMessage({ text }: { text: string }) {
  // Split into lines and render bold (**text**) inline
  const lines = text.split("\n");
  return (
    <span>
      {lines.map((line, li) => {
        // bullet
        const isBullet = /^[-•*]\s/.test(line.trim());
        const content = line.replace(/^[-•*]\s/, "");
        const parts = content.split(/(\*\*[^*]+\*\*)/g);
        const rendered = parts.map((p, pi) =>
          p.startsWith("**") && p.endsWith("**")
            ? <strong key={pi}>{p.slice(2, -2)}</strong>
            : <span key={pi}>{p}</span>
        );
        return (
          <span key={li}>
            {isBullet && <span className="mr-1.5 text-violet-400">•</span>}
            {rendered}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </span>
  );
}

// ── Typing dots ────────────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 150, 300].map(delay => (
        <span
          key={delay}
          className="w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DeepSeekChat() {
  const [open, setOpen]           = useState(false);
  const [expanded, setExpanded]   = useState(false);
  const [messages, setMessages]   = useState<Message[]>([]);
  const [input, setInput]         = useState("");
  const [streaming, setStreaming] = useState(false);
  const [unread, setUnread]       = useState(0);
  const [showSugg, setShowSugg]   = useState(true);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const abortRef   = useRef<AbortController | null>(null);

  const scrollBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => { if (open) { scrollBottom(); inputRef.current?.focus(); } }, [open]);
  useEffect(() => { if (open) scrollBottom(); }, [messages]);
  useEffect(() => {
    if (!open && messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      setUnread(n => n + 1);
    }
  }, [messages]);
  useEffect(() => { if (open) setUnread(0); }, [open]);

  // ── Send message ─────────────────────────────────────────────────────────────

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");
    setShowSugg(false);

    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content };
    const aiId = `a-${Date.now() + 1}`;
    const aiMsg: Message  = { id: aiId, role: "assistant", content: "", streaming: true };

    setMessages(prev => [...prev, userMsg, aiMsg]);
    setStreaming(true);

    // Build history (exclude the empty placeholder)
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    try {
      abortRef.current = new AbortController();
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Network error" }));
        setMessages(prev => prev.map(m =>
          m.id === aiId ? { ...m, content: err.error || "Something went wrong.", streaming: false, error: true } : m
        ));
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.t) {
              accumulated += parsed.t;
              setMessages(prev => prev.map(m =>
                m.id === aiId ? { ...m, content: accumulated } : m
              ));
            }
          } catch (e: any) {
            if (e?.message && !e.message.includes("JSON")) {
              setMessages(prev => prev.map(m =>
                m.id === aiId ? { ...m, content: "Error: " + e.message, error: true } : m
              ));
              return;
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setMessages(prev => prev.map(m =>
          m.id === aiId ? { ...m, content: "Connection lost. Please try again.", error: true } : m
        ));
      }
    } finally {
      setMessages(prev => prev.map(m =>
        m.id === aiId ? { ...m, streaming: false } : m
      ));
      setStreaming(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
    setMessages(prev => prev.map(m =>
      m.streaming ? { ...m, streaming: false } : m
    ));
  }

  function clear() {
    abortRef.current?.abort();
    setMessages([]);
    setShowSugg(true);
    setStreaming(false);
  }

  function handleKey(e: import("react").KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Panel sizing
  const panelW = expanded ? "w-[700px]" : "w-[400px]";
  const panelH = expanded ? "h-[720px]" : "h-[580px]";

  return (
    <>
      {/* ── Floating trigger button ──────────────────────────────────────────── */}
      <AnimatePresence>
        {!open && (
          <motion.button
            key="fab"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-6 right-6 z-50 group"
          >
            <div className="relative bg-violet-600 hover:bg-violet-700 text-white rounded-2xl w-14 h-14 flex items-center justify-center shadow-xl shadow-violet-500/25 transition-all duration-200 hover:scale-105 hover:shadow-violet-500/40">
              <Brain size={24} />
              {/* Pulse ring */}
              <span className="absolute inset-0 rounded-2xl bg-violet-500 animate-ping opacity-20" />
              {/* Unread badge */}
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
                  {unread}
                </span>
              )}
            </div>
            {/* Tooltip */}
            <span className="absolute right-16 top-1/2 -translate-y-1/2 bg-dark text-white text-xs font-medium px-2.5 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-lg">
              Ask DeepSeek
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Chat panel ───────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 32, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 32, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            className={`fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden border border-dark/12
                        ${panelW} ${panelH}`}
            style={{
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "calc(100dvh - 24px)",
              background: "#F5EEDC",
            }}
          >
            {/* ── Header ───────────────────────────────────────────────────── */}
            <div
              className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{ background: "linear-gradient(135deg, #5b21b6 0%, #4c1d95 100%)" }}
            >
              <div className="flex items-center gap-2.5">
                <div className="bg-white/15 p-1.5 rounded-xl">
                  <Brain size={17} className="text-white" />
                </div>
                <div>
                  <p className="text-sm font-bold text-white leading-none">Ask DeepSeek</p>
                  <p className="text-xs text-violet-200 mt-0.5">Live dashboard data · deepseek-chat</p>
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={clear}
                  className="p-2 text-violet-200 hover:text-white hover:bg-white/15 rounded-xl transition-all"
                  title="Clear chat"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="p-2 text-violet-200 hover:text-white hover:bg-white/15 rounded-xl transition-all"
                  title={expanded ? "Shrink" : "Expand"}
                >
                  {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="p-2 text-violet-200 hover:text-white hover:bg-white/15 rounded-xl transition-all"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* ── Context chips ─────────────────────────────────────────────── */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-white/60 border-b border-dark/8 shrink-0 overflow-x-auto">
              <span className="text-xs text-dark/40 shrink-0 mr-0.5">Context:</span>
              {CONTEXT_CHIPS.map(({ label, icon: Icon, color }) => (
                <span
                  key={label}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium shrink-0 ${color}`}
                >
                  <Icon size={10} />
                  {label}
                </span>
              ))}
            </div>

            {/* ── Messages ──────────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 scroll-smooth">

              {/* Welcome / empty state */}
              {messages.length === 0 && (
                <div className="text-center py-6 space-y-2">
                  <div className="w-12 h-12 bg-violet-100 rounded-2xl flex items-center justify-center mx-auto border border-violet-200">
                    <Brain size={22} className="text-violet-600" />
                  </div>
                  <p className="text-sm font-semibold text-dark">Hi! I'm DeepSeek.</p>
                  <p className="text-xs text-dark/55 max-w-xs mx-auto leading-relaxed">
                    I can read your live dashboard data — participant positions, 3-min OI patterns, option chain, and AI memory. Ask me anything.
                  </p>
                </div>
              )}

              {/* Message bubbles */}
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex items-end gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {/* Avatar (AI only) */}
                  {msg.role === "assistant" && (
                    <div className="w-6 h-6 rounded-xl bg-violet-100 border border-violet-200 flex items-center justify-center shrink-0 mb-0.5">
                      <Brain size={12} className="text-violet-600" />
                    </div>
                  )}

                  <div
                    className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-violet-600 text-white rounded-br-sm"
                        : msg.error
                        ? "bg-red-50 border border-red-200 text-red-700 rounded-bl-sm"
                        : "bg-white border border-dark/10 text-dark/85 rounded-bl-sm shadow-sm"
                    }`}
                  >
                    {msg.streaming && !msg.content
                      ? <TypingDots />
                      : msg.role === "assistant"
                      ? <RenderMessage text={msg.content} />
                      : msg.content
                    }
                    {/* Blinking cursor while streaming */}
                    {msg.streaming && msg.content && (
                      <span className="inline-block w-0.5 h-[1em] bg-violet-400 ml-0.5 animate-pulse align-middle" />
                    )}
                  </div>
                </div>
              ))}

              <div ref={bottomRef} />
            </div>

            {/* ── Suggestions ───────────────────────────────────────────────── */}
            <AnimatePresence>
              {showSugg && messages.length === 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-3 pb-2 shrink-0 overflow-hidden"
                >
                  <div className="flex items-center gap-1 mb-1.5">
                    <span className="text-xs text-dark/40 font-medium">Try asking:</span>
                    <button
                      onClick={() => setShowSugg(false)}
                      className="text-dark/25 hover:text-dark/50 ml-auto"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        disabled={streaming}
                        className="text-xs px-2.5 py-1.5 bg-white border border-dark/10 rounded-xl text-dark/60
                                   hover:border-violet-300 hover:text-violet-700 hover:bg-violet-50
                                   transition-all disabled:opacity-40"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Input area ────────────────────────────────────────────────── */}
            <div className="px-3 pb-3 shrink-0">
              <div
                className={`flex items-end gap-2 bg-white rounded-xl border transition-all px-3 py-2.5 shadow-sm ${
                  streaming ? "border-violet-300 ring-1 ring-violet-200" : "border-dark/12 focus-within:border-violet-400 focus-within:ring-1 focus-within:ring-violet-200"
                }`}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder={streaming ? "DeepSeek is thinking…" : "Ask about strikes, FII positions, tomorrow's plan…"}
                  disabled={streaming}
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-dark placeholder-dark/30 resize-none outline-none leading-relaxed"
                  style={{ maxHeight: "120px", overflowY: "auto" }}
                  onInput={e => {
                    // Auto-grow
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 120) + "px";
                  }}
                />
                {streaming ? (
                  <button
                    onClick={stop}
                    className="p-1.5 rounded-lg bg-red-100 text-red-600 hover:bg-red-200 transition-all shrink-0"
                    title="Stop"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    disabled={!input.trim()}
                    className={`p-1.5 rounded-lg transition-all shrink-0 ${
                      input.trim()
                        ? "bg-violet-600 text-white hover:bg-violet-700 shadow-sm hover:shadow-violet-300/50"
                        : "bg-dark/8 text-dark/25 cursor-not-allowed"
                    }`}
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
              <p className="text-xs text-dark/25 mt-1.5 text-center">
                Enter to send · Shift+Enter for new line · All live data included
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
