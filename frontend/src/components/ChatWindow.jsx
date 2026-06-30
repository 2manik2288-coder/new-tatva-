import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import useChatStore from '../store/chatStore';
import MessageBubble, { TypingIndicator } from './MessageBubble';

export default function ChatWindow({ isGenerating }) {
  const { messages, isLoading, setPendingSuggestion } = useChatStore();
  const scrollRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, isGenerating, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;

    if (distanceToBottom > 200) {
      setAutoScroll(false);
      setShowScrollBtn(true);
    } else {
      setAutoScroll(true);
      setShowScrollBtn(false);
    }
  };

  const jumpToBottom = () => {
    setAutoScroll(true);
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const validMessages = Array.isArray(messages) ? messages : [];
  const safeData = Array.isArray(validMessages) ? validMessages : [];

  if (safeData.length === 0) return null;

  return (
    <div
      className="flex-1 overflow-y-auto relative pb-32 pt-6 bg-[var(--charcoal)]"
      ref={containerRef}
      onScroll={handleScroll}
      aria-live="polite"
    >
      <div className="max-w-[760px] mx-auto flex flex-col gap-2">

        {safeData.map((msg, idx) => (
          <MessageBubble
            key={msg.id || idx}
            message={msg}
            previousMessage={idx > 0 ? safeData[idx - 1] : null}
            isTyping={false}
            onSendSuggestion={(text) => setPendingSuggestion(text)}
          />
        ))}

        {/* Typing Indicator while generating */}
        <AnimatePresence>
          {isGenerating && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex justify-start px-4 md:px-0 mb-6"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--saffron)] to-[var(--gold)] flex items-center justify-center shadow-lg">
                  <span className="font-display font-bold text-white text-sm">T</span>
                </div>
                <div className="glass-dark rounded-2xl rounded-bl-md px-5 py-3">
                  <TypingIndicator />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fallback loading state */}
        {isLoading && !isGenerating && safeData.length > 0 && safeData[safeData.length - 1]?.role !== 'assistant' && (
          <MessageBubble message={{ role: 'assistant', content: '' }} isTyping={true} />
        )}

        <div ref={scrollRef} style={{ height: '1px' }} />
      </div>

      {/* Jump to Bottom Button */}
      <AnimatePresence>
        {showScrollBtn && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            onClick={jumpToBottom}
            className="fixed bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-2 glass-dark hover:bg-white/5 text-white px-4 py-2 rounded-full text-sm font-sans shadow-xl transition-colors z-40"
          >
            <ArrowDown size={16} />
            Jump to bottom
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
