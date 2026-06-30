import { useState, useMemo } from 'react';
import { ExternalLink, BookOpen, ChevronDown, ChevronUp, Link, FileText, Globe, Play, Folder, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function SourcesPanel({ sources, onClose, inline = false }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const MAX_VISIBLE = 8;

  // ── Process & deduplicate sources ──────────────────────
  const processedSources = useMemo(() => {
    if (!sources || sources.length === 0) return [];

    const seen = new Set();
    const result = [];

    for (const src of sources) {
      let resolvedUrl = src.url || null;
      let resolvedTitle = src.title || null;
      let isWeb = src.type === 'web';

      if (src.type === 'kb' && resolvedTitle) {
        const websiteMatch = resolvedTitle.match(/^Website:\s*(https?:\/\/\S+)/i);
        if (websiteMatch) {
          resolvedUrl = websiteMatch[1];
          isWeb = true;
          resolvedTitle = null;
        } else if (/^https?:\/\//.test(resolvedTitle)) {
          resolvedUrl = resolvedTitle;
          isWeb = true;
          resolvedTitle = null;
        }
        if (!isWeb && src.url && /^https?:\/\//.test(src.url)) {
          resolvedUrl = src.url;
          isWeb = true;
        }
      }

      let domain = null;
      let faviconUrl = null;
      if (resolvedUrl) {
        try {
          const urlObj = new URL(resolvedUrl);
          domain = urlObj.hostname.replace(/^www\./, '');
          faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
        } catch {
          domain = resolvedUrl.substring(0, 40);
        }
      }

      if (!resolvedTitle || resolvedTitle === 'Web Result' || /^https?:\/\//.test(resolvedTitle)) {
        if (domain) {
          resolvedTitle = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
        } else {
          resolvedTitle = isWeb ? 'Web Source' : 'Knowledge Base';
        }
      }

      const dedupeKey = resolvedUrl || `kb-${resolvedTitle}-${result.length}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      result.push({
        title: resolvedTitle,
        url: resolvedUrl,
        domain,
        faviconUrl,
        isWeb,
        preview: src.preview || ''
      });
    }

    return result;
  }, [sources]);

  if (processedSources.length === 0) return null;

  const visibleSources = showAll ? processedSources : processedSources.slice(0, MAX_VISIBLE);
  const hasMore = processedSources.length > MAX_VISIBLE;

  return (
    <div className="mt-2">
      {/* ── Toggle Pill ──────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-2 glass-dark rounded-full px-3.5 py-1.5 text-xs font-sans text-white/50 hover:text-white/80 hover:border-[rgba(201,151,58,0.3)] transition-all"
      >
        <Link size={12} className="text-[var(--gold)]" />
        <span>Sources</span>
        <span className="bg-[rgba(232,131,26,0.15)] text-[var(--saffron)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
          {processedSources.length}
        </span>
        {expanded
          ? <ChevronUp size={12} className="text-white/40" />
          : <ChevronDown size={12} className="text-white/40" />
        }
      </button>

      {/* ── Expanded Panel ───────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="glass-dark rounded-2xl mt-2 p-4">
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Link size={14} className="text-[var(--gold)]" />
                  <span className="font-sans text-xs text-white/60 font-semibold">Sources</span>
                  <span className="text-[10px] text-white/30">{processedSources.length}</span>
                </div>
                <button
                  onClick={() => setExpanded(false)}
                  className="p-1 text-white/30 hover:text-white transition-colors"
                >
                  <ChevronUp size={14} />
                </button>
              </div>

              {/* Source Items */}
              <motion.div
                initial="hidden"
                animate="visible"
                variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
                className="space-y-1.5"
              >
                {visibleSources.map((src, i) => (
                  <SourceItem key={src.url || `src-${i}`} src={src} />
                ))}
              </motion.div>

              {/* Show More/Less */}
              {hasMore && (
                <button
                  onClick={() => setShowAll(!showAll)}
                  className="mt-3 text-[11px] font-sans text-[var(--gold)] hover:text-[var(--saffron)] transition-colors"
                >
                  {showAll ? '← Show fewer' : `+ ${processedSources.length - MAX_VISIBLE} more sources`}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SOURCE ITEM
   ═══════════════════════════════════════════════ */

function SourceItem({ src }) {
  const [faviconError, setFaviconError] = useState(false);

  // Determine icon
  const getIcon = () => {
    if (src.isWeb) {
      if (src.faviconUrl && !faviconError) {
        return (
          <img
            src={src.faviconUrl}
            width={16}
            height={16}
            className="rounded"
            onError={() => setFaviconError(true)}
            alt=""
          />
        );
      }
      return <Globe size={14} className="text-blue-400" />;
    }
    return <BookOpen size={14} className="text-[var(--gold)]" />;
  };

  const content = (
    <motion.div
      variants={{
        hidden: { opacity: 0, x: -10 },
        visible: { opacity: 1, x: 0 }
      }}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
        src.isWeb && src.url
          ? 'hover:bg-white/5 cursor-pointer group'
          : ''
      }`}
    >
      {/* Icon */}
      <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
        {getIcon()}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="font-sans text-[13px] text-white/85 font-medium truncate leading-tight">
          {src.title}
        </p>
        <p className="font-sans text-[11px] text-white/30 truncate mt-0.5">
          {src.isWeb && src.domain ? src.domain : 'PDF Document'}
        </p>
      </div>

      {/* External Link */}
      {src.isWeb && src.url && (
        <ExternalLink size={12} className="text-white/20 group-hover:text-white/50 transition-colors shrink-0" />
      )}
    </motion.div>
  );

  if (src.isWeb && src.url) {
    return (
      <a href={src.url} target="_blank" rel="noopener noreferrer" className="block no-underline" onClick={e => e.stopPropagation()}>
        {content}
      </a>
    );
  }

  return content;
}
