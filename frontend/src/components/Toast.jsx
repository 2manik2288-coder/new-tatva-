import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';

/* ═══════════════════════════════════════════════
   TOAST CONTEXT
   ═══════════════════════════════════════════════ */

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Return a no-op if used outside provider
    return { addToast: () => {} };
  }
  return ctx;
}

/* ═══════════════════════════════════════════════
   TOAST PROVIDER
   ═══════════════════════════════════════════════ */

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 3000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type, duration }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

/* ═══════════════════════════════════════════════
   TOAST CONTAINER
   ═══════════════════════════════════════════════ */

function ToastContainer({ toasts, removeToast }) {
  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 max-md:right-1/2 max-md:translate-x-1/2 max-md:bottom-4">
      <AnimatePresence>
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TOAST ITEM
   ═══════════════════════════════════════════════ */

const typeConfig = {
  success: { icon: CheckCircle, borderColor: 'border-l-[var(--saffron)]', iconColor: 'text-[var(--saffron)]' },
  error:   { icon: XCircle,     borderColor: 'border-l-red-500',          iconColor: 'text-red-400' },
  info:    { icon: Info,         borderColor: 'border-l-[var(--gold)]',    iconColor: 'text-[var(--gold)]' },
  warning: { icon: AlertTriangle, borderColor: 'border-l-orange-400',     iconColor: 'text-orange-400' },
};

function ToastItem({ toast, onRemove }) {
  const config = typeConfig[toast.type] || typeConfig.info;
  const Icon = config.icon;

  useEffect(() => {
    const timer = setTimeout(onRemove, toast.duration || 3000);
    return () => clearTimeout(timer);
  }, [toast.duration, onRemove]);

  return (
    <motion.div
      initial={{ x: 100, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 100, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      className={`glass-dark rounded-xl px-4 py-3 flex items-center gap-3 min-w-[280px] max-w-[400px] border-l-4 ${config.borderColor} shadow-xl`}
    >
      <Icon size={18} className={`${config.iconColor} shrink-0`} />
      <p className="font-sans text-sm text-white flex-1">{toast.message}</p>
      <button
        onClick={onRemove}
        className="p-1 text-white/30 hover:text-white transition-colors shrink-0"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

export default ToastProvider;
