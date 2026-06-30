import { X, Sun, Moon, Monitor, Type, Volume2, Globe, Eye, Trash2, Info } from 'lucide-react';
import useChatStore from '../store/chatStore';
import { useAuth } from '../App';

export default function Settings() {
  const { settingsOpen, setSettingsOpen, settings, updateSetting, activeModel, clearMessages } = useChatStore();
  const { user, signOut } = useAuth();

  if (!settingsOpen) return null;

  const themes = [
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'system', label: 'System', icon: Monitor },
  ];

  const fontSizes = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];

  const languages = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'en', label: 'English' },
    { value: 'hi', label: 'Hindi / Hinglish' },
  ];

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/60 z-[60]" onClick={() => setSettingsOpen(false)} />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[340px] max-w-[90vw] bg-[#1a1820] border-l border-[var(--border-glass)] z-[70] flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-glass)]">
          <h2 className="text-lg font-medium text-[var(--text-primary)]">Settings</h2>
          <button onClick={() => setSettingsOpen(false)} className="p-1.5 rounded-lg hover:bg-white/5 transition-default">
            <X size={18} className="text-[var(--text-muted)]" />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-6">
          {/* Profile */}
          {user && (
            <section>
              <h3 className="settings-label">Profile</h3>
              <div className="settings-card flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--accent-amber-dim)] flex items-center justify-center">
                  <span className="text-[var(--accent-amber)] font-medium text-sm">{(user.firstName || 'U')[0].toUpperCase()}</span>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-[var(--text-primary)] font-medium">{user.firstName || user.fullName || 'Explorer'}</p>
                  <p className="text-[11px] text-[var(--text-muted)]">Local account</p>
                </div>
              </div>
            </section>
          )}

          {/* Theme */}
          <section>
            <h3 className="settings-label"><Sun size={14} /> Theme</h3>
            <div className="flex gap-2">
              {themes.map(t => (
                <button
                  key={t.value}
                  onClick={() => updateSetting('theme', t.value)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-medium transition-default ${
                    settings.theme === t.value
                      ? 'bg-[var(--accent-amber)] text-black'
                      : 'bg-white/4 text-[var(--text-secondary)] hover:bg-white/6 border border-[var(--border-glass)]'
                  }`}
                >
                  <t.icon size={13} />
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* Response Language */}
          <section>
            <h3 className="settings-label"><Globe size={14} /> Response Language</h3>
            <div className="settings-card space-y-1">
              {languages.map(l => (
                <button
                  key={l.value}
                  onClick={() => updateSetting('language', l.value)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-default ${
                    settings.language === l.value
                      ? 'bg-[var(--accent-amber-dim)] text-[var(--accent-amber)]'
                      : 'text-[var(--text-secondary)] hover:bg-white/4'
                  }`}
                >
                  {l.label}
                  {settings.language === l.value && <span className="float-right">✓</span>}
                </button>
              ))}
            </div>
          </section>

          {/* Font Size */}
          <section>
            <h3 className="settings-label"><Type size={14} /> Text Size</h3>
            <div className="flex gap-2">
              {fontSizes.map(f => (
                <button
                  key={f.value}
                  onClick={() => updateSetting('fontSize', f.value)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium transition-default ${
                    settings.fontSize === f.value
                      ? 'bg-[var(--accent-amber)] text-black'
                      : 'bg-white/4 text-[var(--text-secondary)] hover:bg-white/6 border border-[var(--border-glass)]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </section>

          {/* Speech Rate */}
          <section>
            <h3 className="settings-label"><Volume2 size={14} /> Speech Speed</h3>
            <div className="flex gap-2">
              {[0.75, 1, 1.25, 1.5].map(r => (
                <button
                  key={r}
                  onClick={() => updateSetting('speechRate', r)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium transition-default ${
                    settings.speechRate === r
                      ? 'bg-[var(--accent-amber)] text-black'
                      : 'bg-white/4 text-[var(--text-secondary)] hover:bg-white/6 border border-[var(--border-glass)]'
                  }`}
                >
                  {r}x
                </button>
              ))}
            </div>
          </section>

          {/* Show Sources */}
          <section>
            <h3 className="settings-label"><Eye size={14} /> Sources</h3>
            <div className="settings-card">
              <button
                onClick={() => updateSetting('showSources', !settings.showSources)}
                className="w-full flex items-center justify-between py-1"
              >
                <span className="text-sm text-[var(--text-secondary)]">Show answer sources</span>
                <div className={`w-9 h-5 rounded-full transition-default relative ${settings.showSources ? 'bg-[var(--accent-amber)]' : 'bg-white/10'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${settings.showSources ? 'left-[18px]' : 'left-0.5'}`} />
                </div>
              </button>
            </div>
          </section>

          {/* Active Model */}
          <section>
            <h3 className="settings-label"><Info size={14} /> Active Model</h3>
            <div className="settings-card">
              <p className="text-sm text-[var(--text-secondary)]">{activeModel || 'llama-3.3-70b-versatile'}</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-1">Automatically switches to backup models if needed</p>
            </div>
          </section>

          {/* Danger Zone */}
          <section>
            <h3 className="settings-label text-red-400/70"><Trash2 size={14} /> Data</h3>
            <div className="space-y-2">
              <button
                onClick={() => { clearMessages(); setSettingsOpen(false); }}
                className="w-full px-3 py-2.5 rounded-xl text-sm text-red-400/80 bg-red-500/5 border border-red-500/10 hover:bg-red-500/10 transition-default text-left"
              >
                Clear current conversation
              </button>
              {user && (
                <button
                  onClick={() => { signOut(); setSettingsOpen(false); }}
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-[var(--text-secondary)] bg-white/3 border border-[var(--border-glass)] hover:bg-white/5 transition-default text-left"
                >
                  Sign out
                </button>
              )}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-[var(--border-glass)]">
          <p className="text-[11px] text-[var(--text-muted)] text-center">Tatva AI v1.0.0 — The essence of knowledge</p>
        </div>
      </div>
    </>
  );
}
