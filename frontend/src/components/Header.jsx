import { Menu, Settings, ChevronDown } from 'lucide-react';
import useChatStore from '../store/chatStore';

export default function Header() {
  const { messages, activeModel, toggleSidebar, toggleSettings } = useChatStore();

  const hasMessages = messages.length > 0;
  const modelShort = (activeModel || 'llama-3.3-70b').split('/').pop().replace('-versatile', '');

  return (
    <header className="h-12 flex items-center px-3 bg-transparent z-20 flex-shrink-0">
      {/* Hamburger */}
      <button onClick={toggleSidebar} className="p-2 rounded-xl hover:bg-white/5 transition-default md:hidden">
        <Menu size={20} className="text-[var(--text-secondary)]" />
      </button>

      {/* Model selector dropdown look */}
      <div className="flex items-center gap-1 ml-1 md:ml-0">
        <span className="font-heading text-lg text-[var(--text-primary)] tracking-wide">Tatva</span>
        {hasMessages && (
          <button className="flex items-center gap-0.5 ml-1 text-[11px] px-2 py-1 rounded-lg bg-white/4 border border-[var(--border-glass)] text-[var(--text-muted)] hover:bg-white/6 transition-default">
            {modelShort}
            <ChevronDown size={11} />
          </button>
        )}
      </div>

      <div className="flex-1" />

      {/* Settings */}
      <button onClick={toggleSettings} className="p-2 rounded-xl hover:bg-white/5 transition-default">
        <Settings size={18} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]" />
      </button>
    </header>
  );
}
