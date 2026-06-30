import { useEffect, useState } from 'react';
import { Plus, Trash2, X, PanelLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import useChatStore from '../store/chatStore';
import axios from 'axios';

export default function Sidebar() {
  const {
    isSidebarOpen, setSidebarOpen, clearMessages,
    currentConversationId,
    setConversationId, loadConversation
  } = useChatStore();
  const [loading, setLoading] = useState(false);

  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
  const userId = 'local-user';

  // Sidebar history temporarily disabled
  const [conversations, setConversations] = useState([]);

  const handleNewChat = () => {
    clearMessages();
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleLoadConversation = (conv) => {
    loadConversation([
      { role: 'user', content: conv.user_message, timestamp: conv.created_at },
      { role: 'assistant', content: conv.ai_response, source: conv.source, timestamp: conv.created_at }
    ]);
    setConversationId(conv.id);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleDelete = async (e, convId) => {
    e.stopPropagation();
    try {
      await axios.delete(`${backendUrl}/api/history/${convId}`);
      setConversations(conversations.filter(c => c.id !== convId));
    } catch {}
  };

  const groupConversations = (convs) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const groups = { 'Today': [], 'Yesterday': [], 'This Week': [], 'Older': [] };
    for (const c of convs) {
      const d = new Date(c.created_at);
      if (d >= today) groups['Today'].push(c);
      else if (d >= yesterday) groups['Yesterday'].push(c);
      else if (d >= weekAgo) groups['This Week'].push(c);
      else groups['Older'].push(c);
    }
    return groups;
  };
  const grouped = groupConversations(conversations);

  return (
    <>
      {/* Mobile Backdrop */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-40 md:hidden backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside
        className={`fixed md:relative top-0 left-0 h-full w-[260px] bg-[var(--charcoal-mid)] text-white z-50 flex flex-col transition-all duration-300 ease-in-out border-r border-[rgba(201,151,58,0.08)] font-sans
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:-ml-[260px]'}`}
      >
        {/* Header */}
        <div className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full border border-[var(--gold)] flex items-center justify-center">
              <span className="font-display italic text-[var(--gold)] text-sm mt-0.5">त</span>
            </div>
            <span className="font-display font-bold text-lg text-white">Tatva AI</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1 text-white/40 hover:text-white transition-colors"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="px-4 mb-3">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center justify-center gap-2 border border-[rgba(201,151,58,0.2)] bg-transparent text-white/70 hover:text-white rounded-xl p-2.5 text-sm font-sans hover:bg-[rgba(232,131,26,0.08)] hover:border-[var(--saffron)] transition-all"
          >
            <Plus size={16} />
            <span>New Chat</span>
          </button>
        </div>

        {/* Conversation History */}
        <div className="flex-1 overflow-y-auto scrollbar-hide py-2">
          {loading && (
            <p className="text-center text-white/40 text-xs py-4">Loading history...</p>
          )}

          {!loading && conversations.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 opacity-30">
              <p className="text-xs text-center font-sans leading-relaxed">
                Your conversations<br />will appear here
              </p>
            </div>
          )}

          {Object.entries(grouped).map(([group, convs]) => {
            if (convs.length === 0) return null;
            return (
              <div key={group} className="mb-4">
                <h3 className="text-[11px] font-sans tracking-[2px] uppercase text-white/25 px-4 py-2 font-semibold">
                  {group}
                </h3>
                <div className="flex flex-col gap-0.5 px-2">
                  {convs.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => handleLoadConversation(conv)}
                      className={`group relative flex items-center gap-2 px-4 py-2.5 w-full rounded-xl text-[13px] text-left transition-all font-sans
                        ${currentConversationId === conv.id
                          ? 'bg-[rgba(232,131,26,0.12)] text-white border-l-2 border-[var(--saffron)] pl-3.5'
                          : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                        }`}
                    >
                      <span className="truncate flex-1 leading-tight">
                        {conv.user_message?.substring(0, 40) || 'Untitled Chat'}
                      </span>
                      <div className="absolute right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => handleDelete(e, conv.id)}
                          className="p-1 text-white/30 hover:text-red-400 rounded transition-colors"
                          aria-label="Delete conversation"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-auto">
          <div className="h-px w-full bg-[rgba(201,151,58,0.1)]" />
          <div className="p-4 flex items-center justify-center gap-3">
            <div className="w-7 h-7 rounded-full border border-[var(--gold)] flex items-center justify-center">
              <span className="font-display italic text-[var(--gold)] text-xs mt-0.5">त</span>
            </div>
            <div className="flex flex-col">
              <span className="font-display font-bold text-sm text-white">Tatva AI</span>
              <span className="font-sans text-[10px] text-white/25">v2.0</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Floating Toggle (desktop) */}
      {!isSidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-4 left-4 z-40 p-2.5 rounded-xl hover:bg-white/5 text-white/50 hover:text-white transition-all hidden md:block"
          aria-label="Open sidebar"
        >
          <PanelLeft size={20} />
        </button>
      )}
    </>
  );
}
