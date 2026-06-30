import { useState, useRef, useEffect, useCallback } from 'react';
import { Paperclip, Mic, MicOff, X, ArrowUp, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import useChatStore from '../store/chatStore';
import { getUserId, saveToMemory } from '../utils/memory';
import { useToast } from './Toast';

export default function InputBar({ isGenerating, setIsGenerating }) {
  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const userId = getUserId();
  const { addToast } = useToast();

  const {
    isLoading, isRecording, uploadedImage,
    setLoading, setRecording, setImage, clearImage,
    addMessage, setActiveModel, setMessages,
    pendingSuggestion, setPendingSuggestion
  } = useChatStore();

  // Auto-expand textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = Math.min(scrollHeight, 160) + 'px';
    }
  }, [text]);

  // ── Image Handling ──────────────────────────────
  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      addToast('Image must be under 10MB', 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result.split(',')[1];
      setImage({ file, base64, previewUrl: URL.createObjectURL(file) });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // ── Voice Recording ─────────────────────────────
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Speech recognition not supported. Use Chrome.'); return; }

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    let silenceTimer = null;

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setText(transcript);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { recognition.stop(); setRecording(false); }, 3000);
    };
    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  }, [isRecording, setRecording]);

  // ── Suggestion Chip Handling ────────────────────
  useEffect(() => {
    if (pendingSuggestion && !isLoading) {
      setPendingSuggestion(null);
      sendMessage(pendingSuggestion);
    }
  }, [pendingSuggestion]);

  // ── Location Helpers ────────────────────────────
  const getCoordinates = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported by this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = {
          lat: position.coords.latitude,
          lon: position.coords.longitude
        };
        console.log('[TATVA GEO] Coordinates obtained:', coords);
        if (isNaN(coords.lat) || isNaN(coords.lon)) {
          reject(new Error('Invalid coordinates received'));
          return;
        }
        resolve(coords);
      },
      (error) => {
        console.error('[TATVA GEO] Permission denied or error:', error.message);
        reject(error);
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  });

  const cleanResponseText = (text) => {
    if (!text) return '';
    return text
      .replace(/context chunk\s*\d*/gi, '')
      .replace(/knowledge base context/gi, '')
      .replace(/from the knowledge base[,:]?\s*/gi, '')
      .replace(/according to the kb[,:]?\s*/gi, '')
      .replace(/source:\s*knowledge base/gi, '')
      .replace(/source:\s*web search/gi, '')
      .replace(/\[kb\]/gi, '')
      .replace(/\[web\]/gi, '')
      .trim();
  };

  const isLocationQuery = (msg) => {
    return /(?:near me|nearby|mere paas|mere aas paas|closest|nearest|around me|kahan milega|kha milega|mere area|my area|my location|mera area)/i.test(msg) ||
      /(?:weather|mausam|temperature|barish|forecast|climate|taapmaan|tapman)\s*(?:of|in|at|for)?\s*(?:my|mere|mera|meri|apne|apna|is|this|yahan|idhar|here|current)?\s*(?:area|location|place|jagah|ilaka|shehar|city)?/i.test(msg) ||
      /(?:my|mere|mera|is|this|yahan|idhar|here)\s*(?:area|location|place|jagah|ilaka|shehar)\s*(?:ka|ki|ke|mein|me|of|in)?\s*(?:weather|mausam|temperature|taapmaan|tapman)/i.test(msg);
  };

  // ═══════════════════════════════════════════════
  // SEND MESSAGE — ALL BACKEND LOGIC PRESERVED
  // ═══════════════════════════════════════════════
  const sendMessage = async (overrideText) => {
    const trimmed = (overrideText || text).trim();
    if (!trimmed && !uploadedImage) return;
    if (isLoading) return;

    const userMsg = {
      id: Date.now(),
      role: 'user',
      content: trimmed || '[Image]',
      imageUrl: uploadedImage?.previewUrl || null,
      sources: [],
      sourceLabel: null
    };

    setText('');
    setLoading(true);
    setIsGenerating(true);
    addMessage(userMsg);

    const imageBase64 = uploadedImage?.base64 || null;
    clearImage();



    const aiMsg = {
      id: Date.now() + 1,
      role: 'assistant',
      content: '',
      sources: [],
      sourceLabel: null,
      isStreaming: true
    };
    addMessage(aiMsg);

    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
      const storeMessages = useChatStore.getState().messages;
      const history = storeMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-12)
        .map(m => ({ role: m.role, content: (m.content || '').trim() }));

      const requestBody = {
        message: trimmed,
        conversationHistory: history.slice(0, -2),
        imageBase64,
        userId
      };

      // Attach coordinates if available
      if (isLocationQuery(trimmed)) {
        try {
          const { lat, lon } = await getCoordinates();
          requestBody.lat = lat;
          requestBody.lon = lon;
        } catch (geoError) {
          // Show inline message in chat area
          addMessage({ 
            id: Date.now() + 2,
            role: 'assistant', 
            content: "I need your location to find nearby places. Please allow location access in your browser and try again.",
            isStreaming: false
          });
          // Remove lat/lon from body and fall through to web search
          delete requestBody.lat;
          delete requestBody.lon;
        }
      }

      const res = await fetch(`${backendUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        let errMsg = 'Server error';
        try {
          const d = await res.json();
          errMsg = d.error || errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      const model = res.headers.get('X-Active-Model');
      if (model) setActiveModel(model);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let finalSources = [];
      let finalLabel = 'DIRECT';

      const updateLastMsg = (updates) => {
        const store = useChatStore.getState();
        const msgs = [...store.messages];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...updates };
        store.setMessages(msgs);
      };

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (!dataStr || dataStr === '[DONE]') continue

          try {
            const data = JSON.parse(dataStr)

            if (data.type === 'token') {
              setIsGenerating(false);
              const tokenText = data.text
              if (!tokenText ||
                  tokenText === 'undefined' ||
                  tokenText === 'null' ||
                  typeof tokenText !== 'string') {
                continue
              }
              fullText += tokenText
              updateLastMsg({ content: fullText })

            } else if (data.type === 'done') {
              fullText = cleanResponseText(fullText);
              finalSources = Array.isArray(data?.sources) ? data.sources : []
              finalLabel = data?.sourceLabel ?? 'TATVA'
              
              updateLastMsg({
                content: fullText,
                sources: finalSources,
                sourceLabel: finalLabel,
                suggestions: Array.isArray(data?.suggestions) ? data.suggestions : [],
                model: data?.model ?? 'unknown',
                chunksUsed: data?.chunksUsed ?? 0,
                isStreaming: false,
                sourcesOpen: false
              })
            }
          } catch(e) {
            continue
          }
        }
      }

      await saveToMemory(userId, trimmed, fullText, finalLabel);

    } catch(e) {
      console.error('Chat error:', e);
      addToast(e.message !== 'Server error' ? e.message : 'Something went wrong. Please try again.', 'error');
      const store = useChatStore.getState();
      const msgs = [...store.messages];
      msgs[msgs.length - 1] = {
        ...msgs[msgs.length - 1],
        content: e.message !== 'Server error' ? e.message : 'Something went wrong. Please try again.',
        isStreaming: false
      };
      store.setMessages(msgs);
    } finally {
      setLoading(false);
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const canSend = (text.trim().length > 0 || uploadedImage) && !isLoading;

  // ═══════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════

  return (
    <div className="fixed bottom-5 left-0 right-0 z-30 flex justify-center pointer-events-none md:pl-0">
      <div
        className={`pointer-events-auto flex flex-col w-[min(760px,calc(100vw-32px))] glass-dark rounded-2xl p-3 transition-all duration-300 ${
          isFocused ? 'shadow-[0_0_30px_rgba(232,131,26,0.12)] border-[rgba(201,151,58,0.3)]' : ''
        }`}
      >
        {/* Image Preview Strip */}
        <AnimatePresence>
          {uploadedImage && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-3 flex gap-2"
            >
              <div className="relative inline-block">
                <img
                  src={uploadedImage.previewUrl}
                  alt="Upload"
                  className="h-14 w-14 rounded-xl object-cover border border-white/20"
                />
                <button
                  onClick={clearImage}
                  className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full p-0.5 shadow-lg hover:bg-red-400 transition-colors"
                  aria-label="Remove image"
                >
                  <X size={10} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input Row */}
        <div className="flex items-end gap-2">
          {/* Attach Button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-xl text-[var(--gold)] hover:text-[var(--saffron)] hover:bg-white/5 transition-all shrink-0"
            title="Attach image"
            aria-label="Attach image"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleImageSelect}
            className="hidden"
          />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Message Tatva..."
            rows={1}
            className="flex-1 bg-transparent border-none outline-none resize-none font-sans text-[15px] text-white placeholder-white/25 max-h-[160px] overflow-y-auto py-2"
          />

          {/* Mic Button */}
          <button
            onClick={toggleRecording}
            className={`p-2 rounded-xl transition-all shrink-0 ${
              isRecording
                ? 'text-[var(--saffron)] bg-[rgba(232,131,26,0.15)] animate-pulse shadow-[0_0_15px_rgba(232,131,26,0.3)]'
                : 'text-[var(--gold)] hover:text-[var(--saffron)] hover:bg-white/5'
            }`}
            title={isRecording ? 'Stop' : 'Speak'}
            aria-label={isRecording ? 'Stop recording' : 'Start recording'}
          >
            {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
          </button>

          {/* Send Button */}
          <button
            onClick={() => sendMessage()}
            disabled={!canSend}
            className={`h-9 w-9 flex items-center justify-center rounded-full transition-all shrink-0 ${
              canSend
                ? 'bg-[var(--saffron)] text-white hover:bg-[var(--saffron-light)] shadow-[0_2px_15px_rgba(232,131,26,0.4)]'
                : 'bg-white/5 text-white/20 cursor-not-allowed'
            }`}
            title="Send message"
            aria-label="Send message"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
