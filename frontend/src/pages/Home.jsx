import { useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, Suspense } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Search, Globe, FileText, Mic, Bookmark, Camera, ArrowRight, ChevronRight, ExternalLink, Heart, ChevronUp } from 'lucide-react';
import * as THREE from 'three';

/* ═══════════════════════════════════════════════
   3D ORB COMPONENT
   ═══════════════════════════════════════════════ */

function WireframeOrb() {
  const meshRef = useRef();
  const particlesRef = useRef();

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.003;
      meshRef.current.rotation.x += 0.001;
    }
    if (particlesRef.current) {
      particlesRef.current.rotation.y -= 0.002;
      particlesRef.current.rotation.z += 0.001;
    }
  });

  // Create particle positions
  const particlePositions = new Float32Array(50 * 3);
  for (let i = 0; i < 50; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 2 + Math.random() * 1.5;
    particlePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    particlePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    particlePositions[i * 3 + 2] = r * Math.cos(phi);
  }

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[1.8, 32, 32]} />
        <meshBasicMaterial color="#C9973A" wireframe transparent opacity={0.3} />
      </mesh>

      <points ref={particlesRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={particlePositions}
            count={50}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial color="#E8831A" size={0.04} sizeAttenuation transparent opacity={0.8} />
      </points>

      <ambientLight intensity={0.4} />
      <pointLight position={[5, 5, 5]} color="#E8831A" intensity={1.5} />
      <pointLight position={[-3, -3, 3]} color="#C9973A" intensity={0.8} />

      <OrbitControls enableZoom={false} autoRotate autoRotateSpeed={0.5} enablePan={false} />
    </group>
  );
}

/* ═══════════════════════════════════════════════
   BENTO FEATURE CARD
   ═══════════════════════════════════════════════ */

function FeatureCard({ children, className = '', span = '', delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`glass-dark rounded-2xl p-8 relative overflow-hidden group transition-all duration-500 hover:border-[rgba(201,151,58,0.3)] ${span} ${className}`}
    >
      {children}
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════
   WAVEFORM ANIMATION
   ═══════════════════════════════════════════════ */

function Waveform() {
  return (
    <div className="flex items-end gap-1 h-8">
      {[0, 0.15, 0.3, 0.45, 0.6].map((d, i) => (
        <div
          key={i}
          className="w-1.5 rounded-full bg-gradient-to-t from-[var(--saffron)] to-[var(--gold)]"
          style={{
            animation: `waveform 1.2s ease-in-out ${d}s infinite`,
            height: '8px',
          }}
        />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   HOME PAGE
   ═══════════════════════════════════════════════ */

export default function Home() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const heroRef = useRef(null);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const stagger = {
    parent: { transition: { staggerChildren: 0.15 } },
    child: {
      initial: { opacity: 0, y: 40 },
      animate: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
    }
  };

  return (
    <div className="min-h-screen bg-[var(--charcoal)] text-white relative overflow-x-hidden">

      {/* ── Floating Orbs ─────────────────────────── */}
      <div className="orb orb-saffron w-[500px] h-[500px] top-[5%] right-[-10%] opacity-40" />
      <div className="orb orb-gold w-[400px] h-[400px] bottom-[20%] left-[-8%] opacity-30" />
      <div className="orb orb-warm w-[300px] h-[300px] top-[50%] left-[40%] opacity-20" />

      {/* ═══════════════ NAVBAR ═══════════════ */}
      <nav className={`fixed top-0 w-full h-[72px] px-6 md:px-12 flex items-center justify-between z-50 transition-all duration-500 ${
        scrolled
          ? 'glass-dark shadow-lg'
          : 'bg-transparent border-b border-transparent'
      }`}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full border border-[var(--gold)] flex items-center justify-center">
            <span className="font-display italic text-[var(--gold)] text-lg leading-none mt-0.5">त</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight text-white">Tatva</span>
        </div>

        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="nav-link font-sans text-sm font-medium text-white/60 hover:text-white transition-colors">Features</a>
          <a href="#philosophy" className="nav-link font-sans text-sm font-medium text-white/60 hover:text-white transition-colors">Knowledge</a>
          <a href="#about" className="nav-link font-sans text-sm font-medium text-white/60 hover:text-white transition-colors">About</a>
        </div>

        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => navigate('/chat')}
          className="bg-[var(--saffron)] text-white px-6 py-2.5 rounded-full font-sans font-semibold text-sm hover:bg-[var(--saffron-light)] transition-colors shadow-[0_0_20px_rgba(232,131,26,0.3)]"
        >
          Open Tatva
        </motion.button>
      </nav>

      {/* ═══════════════ HERO SECTION ═══════════════ */}
      <section ref={heroRef} className="min-h-screen flex items-center relative z-10 pt-[72px]">
        <div className="w-full max-w-[1400px] mx-auto px-6 md:px-12 flex flex-col lg:flex-row items-center gap-12 lg:gap-0">

          {/* Left — Text */}
          <motion.div
            className="flex-1 z-10 text-center lg:text-left"
            initial="initial"
            animate="animate"
            variants={stagger.parent}
          >
            <motion.div variants={stagger.child}>
              <h1 className="font-display font-bold text-5xl md:text-7xl text-[var(--cream)] leading-[1.05] tracking-tight">
                The Essence
              </h1>
              <h1 className="font-display italic font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight mt-1">
                <span className="text-gradient-saffron">of All Knowledge</span>
              </h1>
              {/* Decorative underline */}
              <svg className="w-64 md:w-80 h-3 mt-2 mx-auto lg:mx-0" viewBox="0 0 320 12" fill="none">
                <path d="M2 8 Q80 2 160 8 Q240 14 318 6" stroke="var(--gold)" strokeWidth="2" fill="none" opacity="0.5" />
              </svg>
            </motion.div>

            <motion.p variants={stagger.child} className="font-serif text-lg md:text-xl text-white/50 max-w-lg mt-8 leading-relaxed mx-auto lg:mx-0">
              Ask anything in Hindi, English, or Sanskrit. Tatva answers from ancient wisdom and modern knowledge.
            </motion.p>

            <motion.div variants={stagger.child} className="flex flex-col sm:flex-row items-center gap-4 mt-10 justify-center lg:justify-start">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => navigate('/chat')}
                className="bg-[var(--saffron)] text-white px-8 py-4 rounded-full font-sans font-semibold text-base shadow-[0_4px_30px_rgba(232,131,26,0.4)] hover:shadow-[0_4px_40px_rgba(232,131,26,0.5)] transition-all"
              >
                Start Exploring
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="border border-[var(--gold)] text-[var(--gold)] px-8 py-4 rounded-full font-sans font-semibold text-base hover:bg-[rgba(201,151,58,0.08)] transition-all"
              >
                Watch Demo
              </motion.button>
            </motion.div>
          </motion.div>

          {/* Right — 3D Canvas */}
          <div className="flex-1 w-full h-[400px] lg:h-[600px] relative">
            <Suspense fallback={
              <div className="w-full h-full flex items-center justify-center">
                <div className="w-20 h-20 rounded-full border border-[var(--gold)] flex items-center justify-center animate-pulse">
                  <span className="font-display italic text-[var(--gold)] text-4xl">त</span>
                </div>
              </div>
            }>
              <Canvas
                camera={{ position: [0, 0, 5], fov: 50 }}
                style={{ background: 'transparent' }}
                frameloop="always"
              >
                <WireframeOrb />
              </Canvas>
            </Suspense>
          </div>
        </div>

        {/* Scroll Indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <div className="w-6 h-10 rounded-full border border-[var(--gold)] flex justify-center pt-2"
               style={{ opacity: 0.5 }}>
            <div className="w-1 h-2 rounded-full bg-[var(--gold)]"
                 style={{ animation: 'scroll-bounce 2s ease-in-out infinite' }} />
          </div>
        </div>
      </section>

      {/* ═══════════════ BENTO FEATURES ═══════════════ */}
      <section id="features" className="py-24 md:py-32 px-6 md:px-12 relative z-10">
        <div className="max-w-[1200px] mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="mb-16"
          >
            <h2 className="font-display font-bold text-4xl md:text-5xl text-white tracking-tight">
              What Tatva Can Do
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-5">

            {/* Card 1 — Knowledge Base (7 cols, 2 rows) */}
            <FeatureCard span="md:col-span-7 md:row-span-2" delay={0}>
              <div className="absolute -right-8 -bottom-8 text-[180px] font-display italic text-[var(--gold)] opacity-[0.04] leading-none select-none">
                त
              </div>
              <h3 className="font-display font-bold text-2xl text-white mb-3 relative z-10">Knowledge Base Answers</h3>
              <p className="font-sans text-sm text-white/50 mb-6 relative z-10 max-w-sm">Deep retrieval from your uploaded spiritual texts, PDFs, and documents.</p>
              {/* Mini Chat Preview */}
              <div className="relative z-10 space-y-3 mt-4">
                <div className="flex justify-end">
                  <div className="bg-[var(--saffron)] text-white px-4 py-2 rounded-2xl rounded-br-md text-sm font-sans max-w-[240px]">
                    What is the meaning of Satnam?
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="glass-dark px-4 py-3 rounded-2xl rounded-bl-md text-sm font-serif text-white/80 max-w-[280px] leading-relaxed">
                    Satnam (सतनाम) means "True Name" — the eternal, formless essence of the Supreme Being...
                  </div>
                </div>
              </div>
            </FeatureCard>

            {/* Card 2 — Web Search (5 cols) */}
            <FeatureCard span="md:col-span-5" delay={0.1}>
              <h3 className="font-display font-bold text-xl text-white mb-3">Real-time Web Search</h3>
              <p className="font-sans text-sm text-white/50 mb-4">When your knowledge base doesn't have the answer, Tatva searches the web.</p>
              <div className="flex items-center gap-3 mt-2">
                <Search size={20} className="text-[var(--saffron)]" />
                <div className="flex gap-1.5">
                  {[0, 0.2, 0.4].map((d, i) => (
                    <div key={i} className="w-2 h-2 rounded-full bg-[var(--saffron)]"
                         style={{ animation: `pulse-scale 1.5s ease-in-out ${d}s infinite` }} />
                  ))}
                </div>
              </div>
            </FeatureCard>

            {/* Card 3 — Languages (5 cols) */}
            <FeatureCard span="md:col-span-5" delay={0.2}>
              <h3 className="font-display font-bold text-xl text-white mb-3">Speaks Your Language</h3>
              <p className="font-sans text-sm text-white/50 mb-4">Auto-detects and responds in the language you write.</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <span className="px-4 py-1.5 rounded-full bg-[var(--saffron)] text-white text-xs font-sans font-semibold">Hindi</span>
                <span className="px-4 py-1.5 rounded-full border border-[var(--gold)] text-[var(--gold)] text-xs font-sans font-semibold">Hinglish</span>
                <span className="px-4 py-1.5 rounded-full border border-white/20 text-white/60 text-xs font-sans font-semibold">English</span>
              </div>
            </FeatureCard>

            {/* Card 4 — Upload (7 cols) */}
            <FeatureCard span="md:col-span-7" delay={0.15}>
              <h3 className="font-display font-bold text-xl text-white mb-3">Upload Anything</h3>
              <p className="font-sans text-sm text-white/50 mb-4">PDFs, images, and web links — all ingested into your private knowledge.</p>
              <div className="flex items-center gap-6 mt-2">
                <div className="flex flex-col items-center gap-1">
                  <FileText size={24} className="text-[var(--gold)]" />
                  <span className="text-xs text-white/40 font-sans">PDF</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <Globe size={24} className="text-[var(--gold)]" />
                  <span className="text-xs text-white/40 font-sans">Web</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <Camera size={24} className="text-[var(--gold)]" />
                  <span className="text-xs text-white/40 font-sans">Image</span>
                </div>
              </div>
            </FeatureCard>

            {/* Card 5 — Voice (4 cols) */}
            <FeatureCard span="md:col-span-4" delay={0.25}>
              <h3 className="font-display font-bold text-lg text-white mb-3">Voice Input</h3>
              <p className="font-sans text-xs text-white/50 mb-3">Speak naturally. Tatva listens and responds.</p>
              <Waveform />
            </FeatureCard>

            {/* Card 6 — Memory (4 cols) */}
            <FeatureCard span="md:col-span-4" delay={0.3}>
              <h3 className="font-display font-bold text-lg text-white mb-3">Remembers You</h3>
              <p className="font-sans text-xs text-white/50 mb-3">Conversation history persists across sessions.</p>
              <Bookmark size={28} className="text-[var(--gold)] mt-2" />
            </FeatureCard>

            {/* Card 7 — Image Understanding (4 cols) */}
            <FeatureCard span="md:col-span-4" delay={0.35}>
              <h3 className="font-display font-bold text-lg text-white mb-3">Image Understanding</h3>
              <p className="font-sans text-xs text-white/50 mb-3">Upload images for visual analysis and context.</p>
              <Camera size={28} className="text-[var(--gold)] mt-2" />
            </FeatureCard>
          </div>
        </div>
      </section>

      {/* ═══════════════ PHILOSOPHY STRIP ═══════════════ */}
      <section id="philosophy" className="py-24 md:py-32 px-6 relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="font-display italic text-5xl md:text-7xl text-[var(--gold)]" style={{ animation: 'pulse-glow-text 4s ease-in-out infinite' }}>
            तत्त्वमसि
          </h2>
          <p className="font-serif italic text-lg md:text-xl text-white/40 mt-4">
            "Thou art that"
          </p>
          <p className="font-sans text-base text-white/30 mt-6 max-w-lg mx-auto leading-relaxed">
            Tatva is built on the ancient Vedantic principle that all knowledge is interconnected.
            From the Upanishads to modern science, truth is one.
          </p>
        </motion.div>
      </section>

      {/* ═══════════════ FINAL CTA ═══════════════ */}
      <section id="about" className="py-24 md:py-32 px-6 relative z-10 text-center bg-[var(--cream)] rounded-t-[40px]">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
        >
          <h2 className="font-display font-black text-4xl md:text-6xl text-[var(--ink)] tracking-tight">
            Ready to explore?
          </h2>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/chat')}
            className="mt-10 bg-[var(--saffron)] text-white px-10 py-5 rounded-full font-sans font-bold text-lg shadow-[0_4px_30px_rgba(232,131,26,0.4)] hover:shadow-[0_4px_40px_rgba(232,131,26,0.6)] transition-all inline-flex items-center gap-2"
          >
            Start for Free <ArrowRight size={20} />
          </motion.button>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
            <span className="px-4 py-1.5 rounded-full bg-[var(--saffron-pale)] text-[var(--saffron)] text-xs font-sans font-semibold border border-[rgba(232,131,26,0.2)]">Hindi Support</span>
            <span className="px-4 py-1.5 rounded-full bg-[var(--saffron-pale)] text-[var(--saffron)] text-xs font-sans font-semibold border border-[rgba(232,131,26,0.2)]">Spiritual Knowledge</span>
            <span className="px-4 py-1.5 rounded-full bg-[var(--saffron-pale)] text-[var(--saffron)] text-xs font-sans font-semibold border border-[rgba(232,131,26,0.2)]">Web Search</span>
          </div>
        </motion.div>
      </section>

      {/* ═══════════════ FOOTER ═══════════════ */}
      <footer className="bg-[var(--charcoal)] py-10 px-6 md:px-12 border-t border-[rgba(201,151,58,0.1)]">
        <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-full border border-[var(--gold)] flex items-center justify-center">
              <span className="font-display italic text-[var(--gold)] text-sm">त</span>
            </div>
            <span className="font-display font-bold text-sm text-white">Tatva AI</span>
          </div>
          <p className="font-sans text-xs text-white/30">
            © 2026 Tatva. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <ExternalLink size={16} className="text-white/30 hover:text-white cursor-pointer transition-colors" />
            <Heart size={16} className="text-white/30 hover:text-white cursor-pointer transition-colors" />
          </div>
        </div>
      </footer>
    </div>
  );
}
