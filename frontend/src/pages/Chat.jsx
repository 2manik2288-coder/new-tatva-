import { Menu, Settings as SettingsIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from '../components/Sidebar';
import ChatWindow from '../components/ChatWindow';
import InputBar from '../components/InputBar';
import useChatStore from '../store/chatStore';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserId, loadMemory } from '../utils/memory';

/* ═══════════════════════════════════════════════
   WELCOME SCREEN
   ═══════════════════════════════════════════════ */

function WelcomeScreen() {
  const chips = [
    { text: 'What is Satnam?' },
    { text: 'What is written in Gyan Ganga?' },
    { text: 'Who is Kabir Saheb?' },
    { text: 'What is the path to salvation?' },
    { text: 'Restaurants near me' },
    { text: 'What is naam diksha?' }
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
      {/* Animated Logo */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8"
      >
        <div
          className="w-24 h-24 flex items-center justify-center rounded-full"
          style={{ animation: 'pulse-glow 4s ease-in-out infinite' }}
        >
          <span className="font-display italic text-[80px] text-[var(--gold)] leading-none select-none">
            त
          </span>
        </div>
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="font-display font-bold text-3xl text-white tracking-wide"
      >
        Namaste, Explorer
      </motion.h2>

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
        className="font-serif italic text-lg text-white/40 mt-3"
      >
        तत्त्वमसि · What would you like to explore?
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.5 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-12 max-w-[800px] w-full px-4"
      >
        {chips.map((c, i) => (
          <motion.button
            key={i}
            whileHover={{ scale: 1.03, borderColor: 'var(--saffron)' }}
            whileTap={{ scale: 0.97 }}
            onClick={() => {
              const input = document.querySelector('textarea');
              if (input) {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(input, c.text);
                const ev2 = new Event('input', { bubbles: true });
                input.dispatchEvent(ev2);
                input.focus();
              }
            }}
            className="border border-[rgba(201,151,58,0.25)] bg-[rgba(201,151,58,0.04)] rounded-2xl px-5 py-3 text-sm font-sans text-white/60 hover:text-white hover:bg-[rgba(232,131,26,0.1)] transition-all duration-200 text-center"
          >
            {c.text}
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   CHAT PAGE
   ═══════════════════════════════════════════════ */

export default function Chat() {
  const { messages, setMessages, setSidebarOpen, activeModel, toggleSettings } = useChatStore();
  const [isGenerating, setIsGenerating] = useState(false);
  const setIsGeneratingStore = useChatStore(state => state.setIsGenerating);
  const userId = getUserId();
  const navigate = useNavigate();

  // Keep local generating state in sync with store
  useEffect(() => {
    setIsGeneratingStore(isGenerating);
  }, [isGenerating, setIsGeneratingStore]);

  useEffect(() => {
    async function initMemory() {
      if (messages.length > 0) return;
      const history = await loadMemory(userId);
      if (history.length > 0) {
        const displayMsgs = [];
        for (let i = 0; i < history.length; i++) {
          const h = history[i];
          displayMsgs.push({
            id: Date.now() + i,
            role: h.role,
            content: h.content,
            sources: [],
            sourceLabel: 'MEMORY'
          });
        }
        setMessages(displayMsgs);
      }
    }
    initMemory();
  }, []);

  const hasMessages = messages.length > 0;

  return (
    <div className="h-[100dvh] w-full flex bg-[var(--charcoal)] overflow-hidden font-sans">
      <Sidebar />

      <div className="flex-1 flex flex-col h-full relative transition-all duration-300 min-w-0">

        {/* ── HEADER ─────────────────────────── */}
        <header className="h-14 w-full glass-dark flex items-center justify-between px-4 z-40 relative shrink-0">
          <div className="flex items-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 -ml-2 text-white/50 hover:text-white md:hidden mr-2 transition-colors"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="hidden md:flex items-center gap-2">
              <div className="w-7 h-7 rounded-full border border-[var(--gold)] flex items-center justify-center">
                <span className="font-display italic text-[var(--gold)] text-sm">त</span>
              </div>
            </div>
          </div>

          <div className="font-serif italic text-base text-white/80">
            {hasMessages ? "Current Exploration" : ""}
          </div>

          <div className="flex items-center gap-3">
            <div className="px-3 py-1 rounded-full border border-[var(--saffron)] text-[var(--saffron)] text-xs font-sans hidden sm:block">
              {activeModel || 'LLaMa 3'}
            </div>
            <button
              onClick={() => navigate('/settings')}
              className="p-2 text-[var(--gold)] hover:text-white transition-colors"
              aria-label="Settings"
            >
              <SettingsIcon size={18} />
            </button>
          </div>
        </header>

        {/* ── MAIN CONTENT ───────────────────── */}
        {hasMessages ? (
          <ChatWindow isGenerating={isGenerating} />
        ) : (
          <WelcomeScreen />
        )}

        {/* ── INPUT BAR ──────────────────────── */}
        <InputBar isGenerating={isGenerating} setIsGenerating={setIsGenerating} />
      </div>
    </div>
  );
}
