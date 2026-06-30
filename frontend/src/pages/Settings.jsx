import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Sliders, Database, Info, Trash2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import useChatStore from '../store/chatStore';
import { useToast } from '../components/Toast';

/* ═══════════════════════════════════════════════
   TOGGLE SWITCH
   ═══════════════════════════════════════════════ */

function Toggle({ enabled, onChange }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${
        enabled ? 'bg-[var(--saffron)]' : 'bg-white/10'
      }`}
      aria-label={enabled ? 'Disable' : 'Enable'}
    >
      <div
        className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${
          enabled ? 'translate-x-[20px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}

/* ═══════════════════════════════════════════════
   SETTINGS ROW
   ═══════════════════════════════════════════════ */

function SettingRow({ label, description, children }) {
  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <div className="flex-1 min-w-0">
        <p className="font-sans text-sm text-white font-medium">{label}</p>
        {description && (
          <p className="font-sans text-xs text-white/35 mt-0.5">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SECTION CARD
   ═══════════════════════════════════════════════ */

function SectionCard({ title, icon: Icon, children }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        {Icon && <Icon size={14} className="text-[var(--gold)]" />}
        <h3 className="text-[11px] font-sans tracking-[2px] uppercase text-[var(--gold)] font-semibold">
          {title}
        </h3>
      </div>
      <div className="glass-dark rounded-2xl p-6">
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SETTINGS PAGE
   ═══════════════════════════════════════════════ */

export default function Settings() {
  const navigate = useNavigate();
  const { settings, updateSetting, clearMessages } = useChatStore();
  const { addToast } = useToast();

  // Load persisted settings from localStorage on mount
  const [voiceEnabled, setVoiceEnabled] = useState(() =>
    JSON.parse(localStorage.getItem('tatva_voice') || 'false')
  );
  const [hindiDetect, setHindiDetect] = useState(() =>
    JSON.parse(localStorage.getItem('tatva_hindi') || 'true')
  );
  const [webSearch, setWebSearch] = useState(() =>
    JSON.parse(localStorage.getItem('tatva_websearch') || 'true')
  );
  const [saveHistory, setSaveHistory] = useState(() =>
    JSON.parse(localStorage.getItem('tatva_history') || 'true')
  );
  const [streaming, setStreaming] = useState(() =>
    JSON.parse(localStorage.getItem('tatva_streaming') || 'true')
  );
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [chunkCount, setChunkCount] = useState(0);

  // Persist toggle changes
  const handleToggle = (key, setter, value) => {
    setter(value);
    localStorage.setItem(`tatva_${key}`, JSON.stringify(value));
  };

  // Fetch chunk count
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
        const res = await fetch(`${backendUrl}/api/health`);
        const data = await res.json();
        setChunkCount(data.chunksLoaded || data.chunks || 0);
      } catch {}
    };
    fetchHealth();
  }, []);

  const handleDeleteHistory = () => {
    if (deleteConfirm === 'DELETE') {
      clearMessages();
      localStorage.removeItem('tatva_memory');
      setShowDeleteModal(false);
      setDeleteConfirm('');
      addToast('All history permanently deleted', 'success');
    }
  };

  return (
    <div className="min-h-screen bg-[var(--charcoal)] text-white font-sans">
      {/* Header */}
      <header className="h-14 glass-dark flex items-center px-6 sticky top-0 z-40">
        <button
          onClick={() => navigate('/chat')}
          className="p-2 -ml-2 text-white/50 hover:text-white transition-colors mr-4"
          aria-label="Back to chat"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full border border-[var(--gold)] flex items-center justify-center">
            <span className="font-display italic text-[var(--gold)] text-sm">त</span>
          </div>
          <span className="font-display font-bold text-white">Settings</span>
        </div>
      </header>

      <div className="max-w-[720px] mx-auto px-6 py-10">
        {/* Page Title */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="font-display font-bold text-4xl text-white tracking-tight">Settings</h1>
          <p className="font-serif italic text-white/40 mt-2">Customize your Tatva experience</p>
          <div className="h-px w-full bg-gradient-to-r from-[var(--gold)] to-transparent mt-6 opacity-30" />
        </motion.div>

        <div className="mt-10">
          {/* ── Profile ──────────────────────── */}
          <SectionCard title="Profile" icon={User}>
            <div className="flex items-center gap-4 pb-4 border-b border-white/5">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[var(--saffron)] to-[var(--gold)] flex items-center justify-center text-2xl font-display font-bold text-white shadow-lg">
                त
              </div>
              <div>
                <p className="font-sans text-base text-white font-semibold">Tatva Explorer</p>
                <p className="font-sans text-xs text-white/35 mt-0.5">Local User</p>
              </div>
            </div>
          </SectionCard>

          {/* ── Preferences ──────────────────── */}
          <SectionCard title="Preferences" icon={Sliders}>
            <SettingRow label="Voice Responses" description="Auto-read AI answers aloud">
              <Toggle enabled={voiceEnabled} onChange={(v) => handleToggle('voice', setVoiceEnabled, v)} />
            </SettingRow>
            <div className="h-px bg-white/5" />
            <SettingRow label="Hindi Auto-detect" description="Automatically detect Hindi/Hinglish input">
              <Toggle enabled={hindiDetect} onChange={(v) => handleToggle('hindi', setHindiDetect, v)} />
            </SettingRow>
            <div className="h-px bg-white/5" />
            <SettingRow label="Web Search" description="Search the web when knowledge base lacks an answer">
              <Toggle enabled={webSearch} onChange={(v) => handleToggle('websearch', setWebSearch, v)} />
            </SettingRow>
            <div className="h-px bg-white/5" />
            <SettingRow label="Save Chat History" description="Remember past conversations across sessions">
              <Toggle enabled={saveHistory} onChange={(v) => handleToggle('history', setSaveHistory, v)} />
            </SettingRow>
            <div className="h-px bg-white/5" />
            <SettingRow label="Streaming Responses" description="Show tokens as they arrive">
              <Toggle enabled={streaming} onChange={(v) => handleToggle('streaming', setStreaming, v)} />
            </SettingRow>
          </SectionCard>

          {/* ── Knowledge Base ────────────────── */}
          <SectionCard title="Knowledge Base" icon={Database}>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-sans text-sm text-white">Chunks Loaded</span>
                <span className="font-sans text-sm text-[var(--gold)] font-semibold">{chunkCount}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--saffron)] to-[var(--gold)] transition-all duration-500"
                  style={{ width: `${Math.min((chunkCount / 1000) * 100, 100)}%` }}
                />
              </div>
              <p className="text-xs text-white/30 font-sans">
                Add PDFs and documents to the backend's data/ folder and run ingest_all.py to grow your knowledge base.
              </p>
            </div>
          </SectionCard>

          {/* ── About ────────────────────────── */}
          <SectionCard title="About" icon={Info}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-sans text-sm text-white/50">Version</span>
                <span className="font-sans text-sm text-white">2.0.0</span>
              </div>
              <div className="h-px bg-white/5" />
              <div className="flex items-center justify-between">
                <span className="font-sans text-sm text-white/50">Stack</span>
                <span className="font-sans text-sm text-white">React + Groq + ChromaDB</span>
              </div>
              <div className="h-px bg-white/5" />
              <p className="font-display italic text-[var(--gold)] text-center mt-4 text-lg">
                तत्त्वमसि
              </p>
            </div>
          </SectionCard>

          {/* ── Danger Zone ───────────────────── */}
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Trash2 size={14} className="text-red-400" />
              <h3 className="text-[11px] font-sans tracking-[2px] uppercase text-red-400 font-semibold">
                Danger Zone
              </h3>
            </div>
            <div className="glass-dark rounded-2xl p-6 border-red-500/20">
              <p className="font-sans text-sm text-white/50 mb-4">
                Permanently delete all chat history and stored conversations. This action cannot be undone.
              </p>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="px-5 py-2.5 rounded-xl border border-red-500/30 text-red-400 font-sans text-sm font-semibold hover:bg-red-500/10 hover:border-red-500/50 transition-all"
              >
                Delete All History
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {showDeleteModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowDeleteModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="glass-dark rounded-2xl p-6 max-w-md w-full"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display font-bold text-lg text-white">Confirm Deletion</h3>
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="p-1 text-white/40 hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>
              <p className="font-sans text-sm text-white/50 mb-4">
                Type <span className="text-red-400 font-semibold">DELETE</span> to confirm permanent removal of all history.
              </p>
              <input
                type="text"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="Type DELETE"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white font-sans text-sm outline-none focus:border-red-500/50 transition-colors mb-4"
              />
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 rounded-xl text-white/50 hover:text-white text-sm font-sans transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteHistory}
                  disabled={deleteConfirm !== 'DELETE'}
                  className={`px-5 py-2 rounded-xl text-sm font-sans font-semibold transition-all ${
                    deleteConfirm === 'DELETE'
                      ? 'bg-red-500 text-white hover:bg-red-400'
                      : 'bg-white/5 text-white/20 cursor-not-allowed'
                  }`}
                >
                  Delete Everything
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
