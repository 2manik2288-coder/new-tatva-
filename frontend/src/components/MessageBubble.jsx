import { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { motion } from 'framer-motion';
import { Copy, Check, Volume2, ThumbsUp, ThumbsDown, ArrowRight } from 'lucide-react';
import useChatStore from '../store/chatStore';
import SourcesPanel from './SourcesPanel';
import { useToast } from './Toast';

/* ═══════════════════════════════════════════════
   TYPING INDICATOR
   ═══════════════════════════════════════════════ */

export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-2 px-1">
      {[0, 0.15, 0.3].map((delay, i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-[var(--saffron)]"
          style={{
            animation: `bounce-dot 1.4s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MESSAGE BUBBLE
   ═══════════════════════════════════════════════ */

const MessageBubble = memo(({ message, previousMessage, isTyping = false, onSendSuggestion }) => {
  if (!message || message.content === undefined || message.content === null) {
      return <div className="px-4 py-2 text-sm text-white/40 italic">Message unavailable</div>;
  }
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const { addToast } = useToast();

  // Strip meta tags and extract TATVA thinking block
  let rawContent = (!isTyping && message.content) ? message.content : (message.content || '');
  if (typeof rawContent !== 'string') rawContent = String(rawContent || '');
  
  rawContent = rawContent
    .replace(/\[TATVA_META\][\s\S]*?\[\/TATVA_META\]/g, '')
    .replace(/\[SOURCE:[^\]]*\]/g, '')
    .replace(/\n*---\n*[Ss]ource:[^\n]*/g, '')
    .replace(/\n*\*\*Source:\*\*[^\n]*/g, '')
    .replace(/Context Chunk/gi, '')
    .replace(/Knowledge Base Context/gi, '')
    .replace(/from the knowledge base/gi, '')
    .replace(/according to the KB/gi, '')
    .replace(/Source: Knowledge Base/gi, '')
    .replace(/Source: Web Search/gi, '')
    .replace(/Chunk \d+/gi, '')
    .trim();

  let thinkingContent = '';
  let cleanContent = rawContent;

  const thinkingMatch = rawContent.match(/<tatva_thinking>([\s\S]*?)(?:<\/tatva_thinking>|$)/i);
  if (thinkingMatch) {
    thinkingContent = thinkingMatch[1].trim();
    // Remove the entire block from the main content
    cleanContent = rawContent.replace(/<tatva_thinking>[\s\S]*?(?:<\/tatva_thinking>|$)/i, '').trim();
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(cleanContent || message.content);
    setCopied(true);
    addToast('Copied to clipboard', 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = async (value) => {
    if (feedback !== null) return; // already voted
    setFeedback(value);
    
    // Optimistic UI update
    addToast(value === 1 ? 'Thanks for the feedback! Answer saved.' : 'Feedback received. We will improve this answer.', 'success');

    // Make API call
    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
      const query = previousMessage?.content || 'Unknown Query';
      await fetch(`${backendUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          answer: cleanContent,
          feedback: value
        })
      });
    } catch (err) {
      console.error('Failed to submit feedback:', err);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-6 px-4 md:px-0`}
    >
      <div className={`flex w-full max-w-[90%] gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>

        {/* Avatar */}
        {!isUser && (
          <div className="flex-shrink-0 mt-1">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--saffron)] to-[var(--gold)] flex items-center justify-center shadow-lg">
              <span className="font-display font-bold text-white text-sm">T</span>
            </div>
          </div>
        )}
        {isUser && (
          <div className="flex-shrink-0 mt-1">
            <div className="w-8 h-8 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center">
              <span className="text-xs text-white font-sans font-semibold">U</span>
            </div>
          </div>
        )}

        <div className="flex flex-col min-w-0 w-full">
          {/* Message Content */}
          <div className={`
            rounded-2xl
            ${isUser
              ? 'bg-[#2D2D2D] text-white px-5 py-3 rounded-br-sm border border-white/[0.06]'
              : 'bg-white/[0.04] px-5 py-4 rounded-bl-sm'}
          `}>
            {/* Image attachment */}
            {message.imageUrl && (
              <img
                src={message.imageUrl}
                alt="Uploaded"
                className="max-h-64 rounded-lg mb-3 object-cover border border-white/10"
              />
            )}

            {isTyping ? (
              <TypingIndicator />
            ) : (
              <div className={`max-w-none break-words w-full`}>
                {/* ── TATVA Thinking Block ── */}
                {!isUser && thinkingContent && (
                  <div className="mb-4">
                    <button 
                      onClick={() => setShowThinking(!showThinking)}
                      className="flex items-center gap-2 px-1 py-0.5 text-[11px] font-sans tracking-[1px] uppercase text-white/30 hover:text-[var(--gold)] transition-colors rounded"
                    >
                      <span className="w-4 h-4 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-[9px] font-bold">
                        {showThinking ? '−' : '+'}
                      </span>
                      TATVA CoT Pipeline
                    </button>
                    {showThinking && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="mt-2 p-3 rounded-lg bg-black/40 border border-white/5 font-mono text-[11px] text-white/50 leading-relaxed whitespace-pre-wrap"
                      >
                        {thinkingContent || "Initializing..."}
                      </motion.div>
                    )}
                  </div>
                )}

                <div className={`markdown-content ${
                  isUser
                    ? 'font-sans text-base leading-relaxed'
                    : 'font-sans text-[15px] leading-[1.6] text-white/90'
                }`}>
                <ReactMarkdown
                  components={{
                    p: ({ node, ...props }) => <p className="mb-4 last:mb-0" {...props} />,
                    strong: ({ node, ...props }) => <strong className="font-bold text-[var(--gold-light)]" {...props} />,
                    h1: ({ node, ...props }) => <h1 className="font-display font-bold text-2xl text-white mt-6 mb-3 border-b border-white/10 pb-2" {...props} />,
                    h2: ({ node, ...props }) => <h2 className="font-display font-bold text-xl text-white mt-5 mb-2" {...props} />,
                    h3: ({ node, ...props }) => <h3 className="font-display font-bold text-lg text-white mt-4 mb-2" {...props} />,
                    a: ({ node, ...props }) => <a className="text-[var(--saffron)] underline decoration-[rgba(232,131,26,0.4)] underline-offset-3 hover:decoration-[var(--saffron)] transition-all" target="_blank" rel="noopener noreferrer" {...props} />,
                    ul: ({ node, ...props }) => <ul className="list-disc pl-5 mb-4 space-y-1" {...props} />,
                    ol: ({ node, ...props }) => <ol className="list-decimal pl-5 mb-4 space-y-1" {...props} />,
                    li: ({ node, ...props }) => <li className="text-white/85" {...props} />,
                    blockquote: ({ node, ...props }) => <blockquote className="border-l-2 border-[var(--gold)] pl-4 italic text-white/60 my-4" {...props} />,
                    code({ node, inline, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      if (!inline && match) {
                        return (
                          <div className="relative mt-4 mb-6 group">
                            <div className="absolute top-2 right-2 text-xs text-white/30 font-mono">{match[1]}</div>
                            <SyntaxHighlighter
                              style={vscDarkPlus}
                              language={match[1]}
                              PreTag="div"
                              customStyle={{
                                borderRadius: '12px',
                                fontSize: '13px',
                                margin: 0,
                                background: '#0A0A0A',
                                border: '1px solid rgba(201,151,58,0.1)',
                                padding: '20px'
                              }}
                              {...props}
                            >
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          </div>
                        );
                      }
                      return (
                        <code
                          className="bg-white/5 border border-white/10 px-1.5 py-0.5 rounded text-[13px] font-mono text-[var(--gold-light)]"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    }
                  }}
                >
                  {cleanContent || (isUser ? message.content : '')}
                </ReactMarkdown>
              </div>
            </div>
          )}
          </div>

          {/* AI Message Footer — Sources + Actions */}
          {!isUser && !isTyping && cleanContent && (
            <div className="mt-2 flex flex-col gap-2">
              {/* Sources Panel */}
              {message?.sources && message.sources.length > 0 && !/(Access Denied|403|429|unable to answer)/i.test(message.content) && (
                <SourcesPanel
                  sources={message.sources}
                  inline={true}
                  onClose={() => {}}
                />
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-1">
                <button
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg text-white/30 hover:text-[var(--gold)] hover:bg-white/5 transition-all"
                  title="Copy"
                  aria-label="Copy message"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  className="p-1.5 rounded-lg text-white/30 hover:text-[var(--gold)] hover:bg-white/5 transition-all"
                  title="Read aloud"
                  aria-label="Read aloud"
                  onClick={() => {
                    if ('speechSynthesis' in window) {
                      const utterance = new SpeechSynthesisUtterance(cleanContent);
                      window.speechSynthesis.speak(utterance);
                    }
                  }}
                >
                  <Volume2 size={14} />
                </button>
                <button 
                  onClick={() => handleFeedback(1)}
                  disabled={feedback !== null}
                  className={`p-1.5 rounded-lg transition-all ${feedback === 1 ? 'text-green-400 bg-white/10' : 'text-white/30 hover:text-green-400 hover:bg-white/5'}`} 
                  aria-label="Thumbs up"
                  title="Good answer"
                >
                  <ThumbsUp size={14} />
                </button>
                <button 
                  onClick={() => handleFeedback(-1)}
                  disabled={feedback !== null}
                  className={`p-1.5 rounded-lg transition-all ${feedback === -1 ? 'text-red-400 bg-white/10' : 'text-white/30 hover:text-red-400 hover:bg-white/5'}`} 
                  aria-label="Thumbs down"
                  title="Bad answer"
                >
                  <ThumbsDown size={14} />
                </button>
              </div>

              {/* Suggestion Chips */}
              {message?.suggestions && message.suggestions.length > 0 && (
                <motion.div
                  initial="hidden"
                  animate="visible"
                  variants={{
                    visible: { transition: { staggerChildren: 0.08 } },
                    hidden: {}
                  }}
                  className="flex flex-wrap gap-2 mt-1"
                >
                  {message.suggestions.map((s, i) => (
                    <motion.button
                      key={i}
                      variants={{
                        hidden: { opacity: 0, y: 10 },
                        visible: { opacity: 1, y: 0 }
                      }}
                      onClick={() => onSendSuggestion && onSendSuggestion(s)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[rgba(201,151,58,0.25)] text-xs font-sans text-white/60 hover:text-white hover:border-[var(--saffron)] hover:bg-[rgba(232,131,26,0.08)] transition-all"
                    >
                      {s}
                      <ArrowRight size={10} className="text-[var(--gold)]" />
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
});

export default MessageBubble;
