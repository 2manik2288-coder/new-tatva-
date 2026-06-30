import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, Mic } from 'lucide-react';
import useChatStore from '../store/chatStore';

export default function ChatInput() {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  
  const { 
    isLoading, addMessage, setLoading, 
    uploadedImage, setImage, clearImage, 
    setRecording, isRecording, setActiveModel
  } = useChatStore();

  const handleInput = (e) => {
    setText(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    if (text === '' && textareaRef.current) {
      textareaRef.current.style.height = '1.6em'; // Reset height
    }
  }, [text]);

  const sendMessage = async (coords = {}) => {
    const trimmed = text.trim();
    if (!trimmed && !uploadedImage) return;
    if (isLoading) return;

    // Add user message
    addMessage({ 
      role: 'user', 
      content: trimmed || '[Image]', 
      imageUrl: uploadedImage?.previewUrl || null 
    });
    
    setText('');
    setLoading(true);
    
    const imageBase64 = uploadedImage?.base64 || null;
    clearImage();

    try {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001';
      
      addMessage({ role: 'assistant', content: '', source: '', meta: null });
      
      const res = await fetch(`${backendUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, conversationHistory: [], imageBase64, ...coords })
      });

      if (!res.ok) throw new Error('Network response was not ok');

      const model = res.headers.get('X-Tatva-Model');
      if (model) setActiveModel(model);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        fullText += decoder.decode(value, { stream: true });
        
        const metaMatch = fullText.match(/\[TATVA_META\]([\s\S]*?)\[\/TATVA_META\]/);
        const store = useChatStore.getState();
        const msgs = [...store.messages];
        
        if (metaMatch) {
          const clean = fullText.replace(/\n\n\[TATVA_META\][\s\S]*?\[\/TATVA_META\]/, '').trim();
          let meta = {};
          try { meta = JSON.parse(metaMatch[1]); } catch {}
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: clean, source: meta.source, meta };
        } else {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: fullText };
        }
        
        useChatStore.setState({ messages: msgs });
      }
    } catch (err) {
      const store = useChatStore.getState();
      const msgs = [...store.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: 'Failed to connect to the assistant.' };
        useChatStore.setState({ messages: msgs });
      }
    }
    setLoading(false);
  };

  const initiateSend = () => {
    const trimmed = text.trim();
    if (/near me|nearby/i.test(trimmed)) {
      navigator.geolocation.getCurrentPosition(pos => {
        sendMessage({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude
        });
      }, () => sendMessage({}));
    } else {
      sendMessage({});
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      initiateSend();
    }
  };

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Max 10MB'); return; }
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImage({ 
        file, base64: ev.target.result.split(',')[1], 
        previewUrl: URL.createObjectURL(file) 
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Use Chrome for voice input'); return; }
    
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    
    let timer = null;
    r.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setText(t);
      clearTimeout(timer);
      timer = setTimeout(() => { r.stop(); setRecording(false); }, 3000);
    };
    r.onerror = () => setRecording(false);
    r.onend = () => setRecording(false);
    
    recognitionRef.current = r;
    r.start();
    setRecording(true);
  };

  const canSend = (text.trim().length > 0 || uploadedImage) && !isLoading;

  return (
    <>
      <div className="chat-input-bar">
        {uploadedImage && (
          <div className="absolute -top-16 left-4 flex gap-2">
            <div className="relative">
              <img src={uploadedImage.previewUrl} alt="Preview" className="h-14 w-14 object-cover rounded-xl border border-[rgba(255,255,255,0.2)]" />
              <button onClick={clearImage} className="absolute -top-2 -right-2 bg-[#0c0a0e] text-white p-1 rounded-full shadow border border-[rgba(255,255,255,0.2)]">
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        <button onClick={() => fileInputRef.current?.click()} className="chat-mic-btn" style={{ color: '#94a3b8' }}>
          <Paperclip size={20} />
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} className="hidden" />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message Tatva..."
          className="chat-input-area"
          rows={1}
        />

        {isRecording ? (
          <button onClick={toggleRecording} className="chat-mic-btn mic-pulsing"><Mic size={20} /></button>
        ) : (
          <button onClick={toggleRecording} className="chat-mic-btn"><Mic size={20} /></button>
        )}
        
        <button onClick={initiateSend} disabled={!canSend} className="chat-send-btn">
          <Send size={16} style={{ marginLeft: '2px' }} />
        </button>
      </div>
    </>
  );
}
