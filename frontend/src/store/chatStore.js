import { create } from 'zustand';

const useChatStore = create((set, get) => ({
  messages: [],
  isLoading: false,
  isGenerating: false,
  isRecording: false,
  currentConversationId: null,
  uploadedImage: null,
  activeModel: 'llama-3.3-70b-versatile',
  isSidebarOpen: false,
  conversations: [],
  settingsOpen: false,
  showSources: false,
  activeSources: [],
  pendingSuggestion: null,

  // Settings
  settings: {
    theme: 'dark',
    language: 'auto',
    fontSize: 'medium',
    speechRate: 1,
    showSources: true,
  },

  setMessages: (updater) => set((state) => ({
    messages: typeof updater === 'function' ? updater(state.messages) : updater
  })),

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, {
        ...message,
        timestamp: message.timestamp || new Date().toISOString()
      }]
    })),

  updateLastMessage: (content) =>
    set((state) => {
      const msgs = [...state.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + content };
      }
      return { messages: msgs };
    }),

  setLastMessageSource: (source) =>
    set((state) => {
      const msgs = [...state.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], source };
      }
      return { messages: msgs };
    }),

  setLoading: (isLoading) => set({ isLoading }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setRecording: (isRecording) => set({ isRecording }),
  setImage: (imageObj) => set({ uploadedImage: imageObj }),
  clearImage: () => set({ uploadedImage: null }),
  clearMessages: () => set({ messages: [], currentConversationId: null }),
  setConversationId: (id) => set({ currentConversationId: id }),
  setActiveModel: (model) => set({ activeModel: model }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setConversations: (conversations) => set({ conversations }),
  loadConversation: (messages) => set({ messages }),
  toggleSettings: () => set((state) => ({ settingsOpen: !state.settingsOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  updateSetting: (key, value) => set((state) => ({
    settings: { ...state.settings, [key]: value }
  })),
  setShowSources: (show) => set({ showSources: show }),
  setActiveSources: (sources) => set({ activeSources: sources }),
  setPendingSuggestion: (text) => set({ pendingSuggestion: text }),
}));

export default useChatStore;
