import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';
import { ErrorBoundary, ErrorFallback } from './components/ErrorBoundary';
import Home from './pages/Home';
import Chat from './pages/Chat';
import Settings from './pages/Settings';
import { ToastProvider } from './components/Toast';

/* ═══════════════════════════════════════════════
   LOADING SCREEN
   ═══════════════════════════════════════════════ */

function LoadingScreen({ onComplete }) {
  useEffect(() => {
    const timer = setTimeout(onComplete, 1500);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-0 bg-[var(--charcoal)] z-[9999] flex flex-col items-center justify-center"
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        style={{ animation: 'pulse-glow 2s ease-in-out infinite' }}
        className="w-24 h-24 rounded-full flex items-center justify-center"
      >
        <span className="font-display italic text-[var(--gold)] text-7xl leading-none select-none">
          त
        </span>
      </motion.div>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
        className="font-display font-bold text-white text-xl mt-6 tracking-wide"
      >
        Tatva
      </motion.p>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
        className="mt-4 shimmer w-32 h-0.5 rounded-full"
      />
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════
   ANIMATED ROUTES
   ═══════════════════════════════════════════════ */

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 }
};

const pageTransition = {
  duration: 0.3,
  ease: 'easeInOut'
};

function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={
          <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" transition={pageTransition}>
            <Home />
          </motion.div>
        } />
        <Route path="/chat" element={
          <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" transition={pageTransition} className="h-[100dvh]">
            <Chat />
          </motion.div>
        } />
        <Route path="/settings" element={
          <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" transition={pageTransition}>
            <Settings />
          </motion.div>
        } />
        <Route path="/auth" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  );
}

/* ═══════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════ */

export default function App() {
  const [loading, setLoading] = useState(true);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ToastProvider>
        <BrowserRouter>
          <AnimatePresence>
            {loading && <LoadingScreen onComplete={() => setLoading(false)} />}
          </AnimatePresence>
          {!loading && <AnimatedRoutes />}
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
