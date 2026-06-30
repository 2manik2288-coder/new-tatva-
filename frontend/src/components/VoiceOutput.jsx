import { useState, useRef, useCallback } from 'react';
import { Volume2, VolumeX } from 'lucide-react';

const SPEEDS = [0.75, 1, 1.25, 1.5];

export default function VoiceOutput({ text }) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [speed, setSpeed] = useState(1);
  const utteranceRef = useRef(null);

  const stripMarkdown = (md) => {
    return md
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`[^`]*`/g, '')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[|>_~-]{2,}/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\[SOURCE:[^\]]*\]/g, '')
      .trim();
  };

  const detectVoiceLang = (txt) => {
    const hindiRegex = /[\u0900-\u097F]/;
    return hindiRegex.test(txt) ? 'hi-IN' : 'en-US';
  };

  const handleSpeak = useCallback(() => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    const cleanText = stripMarkdown(text);
    if (!cleanText) return;

    const truncated = cleanText.length > 500 ? cleanText.substring(0, 497) + '...' : cleanText;
    const lang = detectVoiceLang(truncated);

    const utterance = new SpeechSynthesisUtterance(truncated);
    utterance.lang = lang;
    utterance.rate = speed;

    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.lang.startsWith(lang === 'hi-IN' ? 'hi' : 'en'));
    if (preferred) utterance.voice = preferred;

    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }, [text, speed, isSpeaking]);

  const handleSpeedChange = (s) => {
    setSpeed(s);
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  };

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={() => setShowSpeeds(true)}
      onMouseLeave={() => setShowSpeeds(false)}
    >
      <button
        onClick={handleSpeak}
        className="p-1.5 rounded-lg transition-default hover:bg-white/5"
        title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
      >
        {isSpeaking ? (
          <div className="flex items-center gap-0.5 h-4">
            <div className="wave-bar" />
            <div className="wave-bar" />
            <div className="wave-bar" />
          </div>
        ) : (
          <Volume2 size={15} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]" />
        )}
      </button>

      {showSpeeds && (
        <div className="absolute bottom-full left-0 mb-1 flex gap-1 glass-card p-1.5 rounded-lg z-10">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeedChange(s)}
              className={`text-[10px] px-1.5 py-0.5 rounded-md transition-default ${
                speed === s
                  ? 'bg-[var(--accent-amber)] text-black font-medium'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
