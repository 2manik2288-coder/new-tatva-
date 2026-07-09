const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

// ─── BM25 SPARSE SEARCH MODULE ──────────────────────────
const { BM25Index, STOPWORDS } = require('./bm25_index');
const bm25KB = new BM25Index();
const bm25QA = new BM25Index();

// In-memory session store (use Redis for production)
const sessionMemory = new Map();

/// --- SYSTEM PROMPT (v2 — contradiction fixed, interpretive synthesis explicitly authorized) ---
const SYSTEM_PROMPT = `You are Tatva, a spiritual knowledge assistant. You have been given a CONTEXT block below containing retrieved excerpts from a knowledge base of sacred scriptures and verified teachings.

THE ONLY LAW: Every fact, name, event, number, or claim in your answer must be traceable to something explicitly stated in the CONTEXT block. You may reason about and connect those stated details to build an answer — you may never introduce a detail, name, event, or meaning that isn't stated anywhere in the CONTEXT.

ABSOLUTE RESTRICTIONS — violating any of these is a failure:

1. Answers should be logical and make sense based on the context provided
2. NO hallucination. Never generate a verse, quote, name, number, or event that is not word-for-word present in the CONTEXT.
3. Synthesis Mandate. Combine information across ALL relevant context chunks before answering. If one chunk has 3 items and another has 2 more on the same topic, your answer includes all 5. Never answer from a single chunk when other chunks contain more of the same answer.
4. Interpretive Questions Are Allowed. Many questions have no single sentence that directly answers them — e.g. "what is the moral of this story," "summarize this," "why did this happen." For these: read every relevant chunk, identify the events, characters, and statements that ARE present in the CONTEXT, and connect them into a coherent answer (a summary, a moral, a cause-and-effect explanation). This is synthesis, not invention. Every element you connect must itself come from the CONTEXT — do not add a character, event, or detail that never appears in any chunk, and do not import a moral or meaning from outside knowledge of similar stories you may know.
5. Entity Precision. Before merging details from two chunks into one answer, confirm they refer to the same person, entity, or story. Similar or related-sounding names are not automatically the same entity — never merge across entities unless the CONTEXT itself confirms they're the same.
6. Answer Depth. Give comprehensive, detailed answers. When multiple chunks add related details, weave them into a full explanation with specific names, numbers, and mechanisms — but only ones present in the CONTEXT. Depth comes from thorough use of what's retrieved, not from padding.
7. Non-Repetitive Synthesis. State the subject once and merge multiple reasons or aspects into one flowing narrative using transitions like "Furthermore" or "Additionally" — don't restate the subject each time.
8. NO metadata in answers. Never mention "Verified Q&A Bank," document/file names, URLs, chunk numbers, tier labels, or database IDs — these are internal only, invisible to the user.
9. Genuine Gaps Only. If, after reading all context chunks, the SPECIFIC fact or answer the user asked for is not stated in ANY chunk, reply exactly: "The knowledge base does not have sufficient information on this topic." This applies even when chunks discuss the same entity or topic but do NOT contain the particular fact being asked — do NOT substitute a topically-adjacent fact as if it answers the question. Rule 4 (synthesis) only applies when the answer IS present across chunks but requires connecting stated details — it does NOT apply when the specific requested fact simply isn't there. Cross-reference with Rule 11 and 12.
10. Source Hierarchy. Sant Rampal Ji Maharaj's explanations are the highest authority in this knowledge base. When you have chunks from both His explanation and an original scripture (Vedas, Gita, etc.), build the answer primarily from His explanation and use the original scripture as supporting pramaan. Never contradict His explanation using original scripture alone.
11. Multi-Chunk Synthesis Discipline. When your answer draws on more than one chunk, every connection you make between them — every causal link, sequence of events, or relationship — must itself be explicitly stated in at least one chunk. If Chunk A says 'X happened' and Chunk B says 'Y happened,' you may NOT claim 'X caused Y' or 'X led to Y' unless a chunk explicitly states that causal link. Combining chunks means collecting their individual stated facts into one answer, not inferring unstated bridges between them.
12. Grounding Safeguard for User Assertions. If the user's question asserts a claim or premise (e.g., 'Why did X do Y?', 'Since X did Y, how...?', 'I think it is stated that X did Y'), treat this assertion as unverified. Check the retrieved CONTEXT independently to confirm if the assertion (X did Y) is actually stated. Do NOT repeat or affirm the user's assertion as true or stated in the context unless it is explicitly present in the retrieved chunks. If it is not present, clarify that the context does not state this premise, and limit your answer to the verified facts.

HOW TO ANSWER:
- Read the question and decide: is this a direct-fact question, or an interpretive one (summary, moral, reasoning across events)?
- Pull every chunk relevant to the question — for interpretive questions this may mean an entire story or passage, not just one line.
- Build the answer only from what's stated across those chunks, connecting details into a clear, logical narrative where the question calls for it.
- Cite real scripture references only if they appear in the CONTEXT (book name, chapter, verse, page).
- Match the user's language — Hindi, English, or Hinglish — automatically, never ask.
- Length: as deep and comprehensive as the retrieved material supports.

RETRIEVED CONTEXT:
{{CONTEXT_HERE}}`;

// When falling back to the small 8B model, use this simpler prompt it can actually follow
const SYSTEM_PROMPT_8B = `You are Tatva, a spiritual knowledge assistant. Answer ONLY using the CONTEXT below — you have no other knowledge to draw on.

RULES:
1. Every name, fact, event, or number in your answer must come from the CONTEXT. Never add anything that isn't stated there.
2. For questions with no single direct answer — a story's moral, a summary, "why did this happen" — read the relevant chunks and connect the stated events and details into a clear answer. This connecting is allowed and expected. Do not add outside facts, and do not add a meaning or moral that isn't grounded in what's actually in the CONTEXT. Cross-reference with Rule 8 and 9.
3. Never mention "Verified Q&A Bank," document IDs, URLs, or "according to context."
4. Cite real scriptures (book, chapter, verse, page) only if present in the CONTEXT.
5. If the CONTEXT has nothing relevant to the question at all, say exactly: "The knowledge base does not have sufficient information on this topic."
6. Stay on topic — no tangents, no promotional language. Sound like a knowledgeable scholar, not a search engine.
7. Match the user's language (Hindi, English, Hinglish).
8. Multi-Chunk Synthesis Discipline: When combining details from multiple chunks, every causal connection, sequence, or relationship must be explicitly stated in the context. Do not invent links or bridges.
9. Grounding Safeguard for User Assertions: Treat user assertions/premises within questions as unverified. Do not repeat or accept them unless explicitly found in the retrieved context. If absent, clarify that the context does not state this premise.

RETRIEVED CONTEXT:
{{CONTEXT_HERE}}`;

// --- SEMANTIC CACHE ---
// Caches answers for similar questions to avoid redundant API calls (kills 429 rate limits)
const CACHE_FILE = path.join(__dirname, 'semantic_cache.json');
const semanticCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours for persistent cache

// Load cache on startup
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [key, val] of Object.entries(data)) {
      semanticCache.set(key, val);
    }
    console.log(`[Cache] Loaded ${semanticCache.size} entries from persistent store`);
  }
} catch (err) {
  console.warn(`[Cache] Failed to load persistent cache: ${err.message}`);
}

function saveCacheToDisk() {
  try {
    const data = {};
    for (const [key, val] of semanticCache.entries()) {
      data[key] = val;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Cache] Failed to save persistent cache: ${err.message}`);
  }
}

function normalizeQuery(q) {
  return q.toLowerCase().trim()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, '') // keep alphanumeric + Devanagari
    .replace(/\s+/g, ' ')
    .split(' ').sort().join(' '); // sort words for order-independent matching
}

function getCachedAnswer(query) {
  const key = normalizeQuery(query);
  const cached = semanticCache.get(key);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[Cache] HIT for: "${query.substring(0, 50)}..."`);
    return cached;
  }
  if (cached) {
    semanticCache.delete(key); // expired
    saveCacheToDisk();
  }
  return null;
}

function setCachedAnswer(query, answer, sources) {
  const key = normalizeQuery(query);
  semanticCache.set(key, { answer, sources, timestamp: Date.now() });
  // Cap cache size at 500 entries
  if (semanticCache.size > 500) {
    const oldestKey = semanticCache.keys().next().value;
    semanticCache.delete(oldestKey);
  }
  console.log(`[Cache] STORED for: "${query.substring(0, 50)}..." (${semanticCache.size} cached)`);
  saveCacheToDisk();
}

// --- CONTEXT CLEANING (strip URLs/source tags before injecting into prompt) ---
function cleanContext(contextChunks) {
  return contextChunks.map(chunk => {
    const text = typeof chunk === 'string' ? chunk : (chunk.doc || '');
    const cleaned = text
      .replace(/https?:\/\/[^\s)]+/g, '')   // remove URLs
      .replace(/\(Source:.*?\)/gi, '')        // remove (Source: ...)
      .replace(/\(http.*?\)/gi, '')           // remove (http...) in parens
      .replace(/\[Source:.*?\]/gi, '')        // remove [Source: ...]
      .trim();
    if (typeof chunk === 'string') return cleaned;
    return { ...chunk, doc: cleaned };
  });
}

// Source type weight multiplier for weighted retrieval scoring
// QA pairs = 3x boost (curated, highest precision). PDF/Sacred Speech = 2x. Others = 1x.
const SOURCE_WEIGHT = {
  qa: 3.0,
  pdf: 2.0,
  sacred_speech: 2.0,
  youtube: 1.3,
  web_page: 1.0,
  default: 1.0
};

// ─── LONG-TERM MEMORY (persistent across restarts) ───────
const MEMORY_FILE = path.join(__dirname, 'user_memory.json');

function loadLongTermMemory(userId) {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      return data[userId] || {};
    }
  } catch (e) {
    console.warn('[Memory] Load failed:', e.message);
  }
  return {};
}

function saveLongTermMemory(userId, facts) {
  try {
    let data = {};
    if (fs.existsSync(MEMORY_FILE)) {
      data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
    data[userId] = { ...data[userId], ...facts, lastSeen: new Date().toISOString() };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
    console.log('[Memory] Saved facts for', userId, ':', JSON.stringify(facts));
  } catch (e) {
    console.warn('[Memory] Save failed:', e.message);
  }
}

function extractMemoryFacts(message) {
  const facts = {};
  // Extract name
  const nameMatch = message.match(/my name is ([A-Za-z][A-Za-z ]{1,20})/i);
  if (nameMatch) facts.name = nameMatch[1].trim();
  // Extract age
  const ageMatch = message.match(/i am (\d{1,3}) years old/i);
  if (ageMatch) facts.age = ageMatch[1];
  // Extract location
  const locMatch = message.match(/i (?:live in|am from|am in|stay in|belong to) ([A-Za-z][A-Za-z ,]{1,40})/i);
  if (locMatch) facts.location = locMatch[1].trim();
  // Extract language preference from Hindi usage
  if (/[\u0900-\u097F]/.test(message)) facts.preferredLanguage = 'hindi';
  // Extract profession
  const profMatch = message.match(/i (?:am a|work as|am an?) ([A-Za-z][A-Za-z ]{2,30})/i);
  if (profMatch && !profMatch[1].match(/^(from|in|at)\b/i)) facts.profession = profMatch[1].trim();
  return facts;
}

const app = express();
const PORT = process.env.PORT || 5001;

// --- Groq Client Setup ---
const apiKeys = [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean);
if (apiKeys.length === 0 && process.env.GROQ_API_KEY) {
  apiKeys.push(process.env.GROQ_API_KEY);
}

// --- Supabase Client ---
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY &&
    process.env.SUPABASE_URL !== 'your_supabase_url_here') {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('[Tatva] Supabase connected');
  } else {
    console.log('[Tatva] Supabase not configured — history disabled');
  }
} catch (err) {
  console.error('[Tatva] Supabase init error:', err.message);
}

// --- ChromaDB Client ---
const { ChromaClient } = require('chromadb')

let chromaCollection = null
let chromaQACollection = null  // Dedicated QA collection for precision lookup
let chromaReady = false
const COLLECTION_NAME = 'tatva_knowledge'
const QA_COLLECTION_NAME = 'tatva_qa'
const EMBED_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'

async function initChroma() {
  try {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const customEmbedder = {
      generate: async (texts) => {
        try {
          const axios = require('axios');
          const response = await axios.post('http://127.0.0.1:5002/embed', texts, {
            timeout: 5000
          });
          return response.data;
        } catch (serviceErr) {
          console.warn('⚠️ Embedding service offline or failed, falling back to python script:', serviceErr.message);
          try {
            const pythonPath = 'python3';
            const scriptPath = path.join(__dirname, 'embed_query.py');
            const stdout = execFileSync(pythonPath, [scriptPath], {
              input: JSON.stringify(texts),
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            });
            const embeddings = JSON.parse(stdout.trim());
            return embeddings;
          } catch (err) {
            console.error('❌ Python batch embedding fallback failed:', err.message);
            throw err;
          }
        }
      }
    };

    const client = new ChromaClient({
      path: process.env.CHROMA_URL || 'http://localhost:8000'
    })
    const collections = await client.listCollections()
    const collectionNames = collections.map(c => c.name || c._name || c)
    console.log('[Chroma] Collections:', collectionNames)

    if (!collectionNames.length) {
      console.warn('[Chroma] No collections — run ingest_all.py first')
      chromaReady = false
      return
    }

    const found = collectionNames.includes(COLLECTION_NAME)
    const name = found ? COLLECTION_NAME : collectionNames[0]
    if (!found) console.warn(`[Chroma] Using "${name}" instead`)

    chromaCollection = await client.getCollection({ name, embeddingFunction: customEmbedder })
    const count = await chromaCollection.count()
    console.log(`[Chroma] "${name}" has ${count} chunks`)
    chromaReady = count > 0

    // Build BM25 index for KB asynchronously
    if (chromaReady && !bm25KB.ready) {
      bm25KB.buildFromChroma(chromaCollection, name).catch(err => {
        console.error('[BM25] KB building failed:', err);
      });
    }

    // Load dedicated QA collection
    if (collectionNames.includes(QA_COLLECTION_NAME)) {
      chromaQACollection = await client.getCollection({ name: QA_COLLECTION_NAME, embeddingFunction: customEmbedder })
      const qaCount = await chromaQACollection.count()
      console.log(`[Chroma] "${QA_COLLECTION_NAME}" has ${qaCount} verified Q&A pairs`)
      
      // Build BM25 index for QA asynchronously
      if (qaCount > 0 && !bm25QA.ready) {
        bm25QA.buildFromChroma(chromaQACollection, QA_COLLECTION_NAME).catch(err => {
          console.error('[BM25] QA building failed:', err);
        });
      }
    } else {
      console.warn('[Chroma] No QA collection found — run ingest_qa.py')
    }

  } catch (e) {
    console.error('[Chroma] Failed:', e.message)
    chromaReady = false
  }
}

initChroma()
setInterval(() => { if (!chromaReady) initChroma() }, 30000)

function getEmbedding(query) {
  try {
    const escaped = query.replace(/"/g, '\\"').substring(0, 500)
    const out = execSync(
      `python3 ${__dirname}/embed_query.py "${escaped}"`,
      { timeout: 15000 }
    ).toString().trim()
    return JSON.parse(out)
  } catch (e) {
    console.error('[Embed] Failed:', e.message)
    return null
  }
}

async function callGroqJSON(prompt, maxTokens = 250, preferredModels = null) {
  let lastError;
  const models = preferredModels || ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  for (const model of models) {
    for (let i = 0; i < apiKeys.length; i++) {
      try {
        const groq = new Groq({ apiKey: apiKeys[i] });
        const res = await groq.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.0,
          response_format: { type: "json_object" }
        });
        const raw = res.choices[0]?.message?.content?.trim() || '{}';
        return JSON.parse(raw);
      } catch (err) {
        lastError = err;
        console.warn(`[GroqJSON] ${model} with key index ${i} failed: ${err.message?.substring(0, 80)}`);
      }
    }
  }
  throw lastError || new Error("All keys and models failed for JSON completion");
}

async function checkAnswerGrounding(answer, contextChunks, query) {
  if (!answer || answer.length < 50 || !contextChunks || !contextChunks.length) {
    return { grounded: true, ungrounded_claims: [] };
  }

  const lowerAnswer = answer.toLowerCase();
  if (lowerAnswer.includes('does not have sufficient information') || 
      lowerAnswer.includes('do not address') || 
      lowerAnswer.includes('no relevant context') ||
      lowerAnswer.includes('insufficient information')) {
    return { grounded: true, ungrounded_claims: [] };
  }

  try {
    const contextSnippet = contextChunks.map((c, i) => `[Chunk ${i+1}] ${(c.doc || '').substring(0, 400).replace(/\n/g, ' ')}`).join('\n---\n');
    const prompt = `You are a strict spiritual fact-checker. Compare the generated ANSWER against the retrieved SOURCE CHUNKS.

QUESTION: "${query}"

SOURCE CHUNKS:
${contextSnippet}

ANSWER:
${answer.substring(0, 1500)}

Task: Identify if the ANSWER introduces any specific claims, events, names, numbers, or causal connections ("X was expelled because Y", "X got Y by Z") that are NOT explicitly stated in the SOURCE CHUNKS.
- Minor word choice/paraphrasing is fine.
- However, if the answer invents a detail, bridges separate chunks using unstated causal links, or asserts facts not found in any chunk, mark it as ungrounded.

Return JSON only in this format:
{
  "grounded": true or false,
  "ungrounded_claims": ["specific ungrounded claim or connection 1", ...]
}

JSON object only:`;

    const parsed = await callGroqJSON(prompt, 250, ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    return parsed;
  } catch (err) {
    console.warn(`[Grounding] Grounding check failed: ${err.message}`);
    return { grounded: true, ungrounded_claims: [] };
  }
}


// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please wait a moment before trying again.' }
});
app.use('/api/', limiter);

// --- Multer for PDF uploads ---
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  }
});

// --- Model Fallback ---
const MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant'
];

async function callGroqWithFallback(messages, isVision = false, temperature = 0.1, top_p = 0.1, stream = true) {
  const visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct'

  if (isVision) {
    const groq = new Groq({ apiKey: apiKeys[0] || 'dummy' });
    const response = await groq.chat.completions.create({
      model: visionModel,
      messages,
      stream,
      max_tokens: 1024
    })
    return { response, model: visionModel }
  }

  let lastError;
  let retryCount = 0;
  const maxRetries = 2;

  while (retryCount <= maxRetries) {
    for (const model of MODELS) {
      for (let i = 0; i < apiKeys.length; i++) {
        try {
          const groq = new Groq({ apiKey: apiKeys[i] });
          const response = await groq.chat.completions.create({
            model,
            messages,
            stream,
            temperature,
            frequency_penalty: 1.0,
            presence_penalty: 0.5,
            max_tokens: 4096
          });
          console.log(`[Groq] Using model: ${model} with key index ${i}`);
          // Track if we're using the 8B model so we can degrade the prompt
          return { response, model, is8B: model.includes('8b') };
        } catch (error) {
          lastError = error;
          const status = error.response?.status || error?.status || error?.statusCode;
          console.warn(`[Groq] ${model} with key ${i} failed: ${status} — ${error.message?.substring(0, 80)}`);

          if (status === 429) {
            console.log(`[Groq] Key ${i} rate limited on ${model}. Switching keys...`);
            // Throttle delay: Gives the 70B model a breather so we don't instantly failover to 8B
            await new Promise(r => setTimeout(r, 4000));
            continue;
          }
          if (status === 413) {
            console.log(`[Groq] Payload too large for ${model}. Downgrading model...`);
            if (messages[0]?.role === 'system') {
              const sysLen = messages[0].content.length;
              if (sysLen > 8000) {
                messages[0].content = messages[0].content.substring(0, 8000) + '\n[Context trimmed]';
              }
            }
            if (messages.length > 2) messages.splice(1, 1);
            break;
          }
          if (status === 400) break;
        }
      }
    }

    const finalStatus = lastError?.response?.status || lastError?.status || lastError?.statusCode;
    if (finalStatus === 429 && retryCount < maxRetries) {
      retryCount++;
      const delay = Math.pow(2, retryCount) * 3000; // 6s, 12s, 24s, 48s
      console.log(`[Groq] All models rate-limited. Retrying in ${delay}ms... (Attempt ${retryCount}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    break; // Exhausted retries or not a retryable error
  }

  // Graceful fallback to avoid 500 errors in production UI if API is fully blocked
  console.log('[Groq] All fallbacks exhausted. Triggering graceful fallback stream.', lastError?.message);

  const status = lastError?.response?.status || lastError?.status || lastError?.statusCode;
  let msg = "Internet connection check karo aur dobara try karo.";

  if (status === 429) {
    msg = "Main abhi thoda busy hoon — ek second mein dobara try karo.";
  } else if (status === 403 || status === 401) {
    msg = "Kuch technical issue aa gaya. Agar yeh baar baar ho raha hai toh admin se API key check karne ko kaho.";
  }

  const mockStream = (async function* () {
    const words = msg.split(' ');
    for (const word of words) {
      yield { choices: [{ delta: { content: word + ' ' } }] };
      await new Promise(r => setTimeout(r, 40));
    }
  })();
  return { response: mockStream, model: 'local-fallback' };
}

// ─── QUERY CLASSIFIER (CONTEXT-AWARE ROUTING) ─────────────
function classifyQuery(message, conversationHistory = []) {
  try {
    const query = message.trim();
    const queryLower = query.toLowerCase();

    // ── TIER CASUAL (TIME/DATE DIRECT) ──
    if (['time', 'what time is it', 'current time'].includes(queryLower)) return { type: 'CASUAL_TIME' };
    if (['date', 'what is today', 'current date', 'today'].includes(queryLower)) return { type: 'CASUAL_DATE' };

    // ── TIER CASUAL (MATH & GREETINGS) ──
    if (/^[\d\s+\-*/()%.]+$/.test(query) && /\d/.test(query) && /[+\-*/%]/.test(query)) {
      return { type: 'CASUAL_MATH', data: query };
    }
    const greetings = ['hello', 'hi', 'hey', 'namaste', 'jai satlok', 'sat saheb'];
    if (greetings.some(g => queryLower === g || queryLower === g + '!')) {
      return { type: 'CASUAL_GREETING' };
    }


    // ── TIER 0 — GIBBERISH DETECTION ──
    const isGibberish = (msg) => {
      const clean = msg.toLowerCase();
      if (clean.length < 12) {
        const words = clean.split(/\s+/);
        const hasRealWord = words.some(w => w.length > 3 && /[aeiouy]/i.test(w));
        if (!hasRealWord) return true;
      }
      if (/^[^aeiou\s]{3,}$/i.test(clean.replace(/[^a-z]/g, ''))) return true;
      return false;
    };
    if (isGibberish(query)) return { type: 'CASUAL_GIBBERISH' };

    // ── TIER 0 — SLANG & INTERNET LANGUAGE ──
    const slangTerms = [
      'lol', 'lmao', 'bruh', 'fr', 'no cap', 'based', 'ratio', 'slay', 'vibe check', 'rizz',
      'bussin', 'goated', 'lowkey', 'highkey', 'mid', 'sheesh', 'yeet', 'sus', 'bet', 'w', 'l',
      'gg', 'rip', 'omg', 'wtf', 'smh', 'idk', 'idc', 'tbh', 'ngl', 'imo', 'fomo', 'yolo',
      'banger', 'salty', 'ghosting', 'stan', 'simp', 'chad', 'sigma', 'grindset', 'main character',
      'understood the assignment', 'living rent free', 'it is what it is', 'hits different',
      'ate and left no crumbs', 'delulu', 'periodt', 'era', 'no thoughts just vibes',
      'bindaas', 'jugaad', 'bakwaas', 'timepass', 'mast', 'tharki', 'scene', 'fattu', 'sahi hai'
    ];
    const isSlang = slangTerms.some(s => queryLower === s || queryLower.startsWith(s + ' '));
    if (isSlang) return { type: 'CASUAL_SLANG' };

    // ── TIER 0 — REACTIONS & AFFIRMATIONS ──
    const reactions = [
      'thanks', 'ok', 'got it', 'nice', 'wow', 'cool', 'interesting', 'understood',
      'hmm', 'haha', 'sure', 'yes', 'no', 'okay', 'alright', 'makes sense', 'great'
    ];
    if (reactions.some(r => queryLower === r || queryLower === r + '!')) {
      return { type: 'CASUAL_REACTION' };
    }

    // ── TIER 0 — FOLLOW-UP DETECTION ──
    const wordsCount = query.split(/\s+/).length;
    const hasPronoun = /\b(it|this|that|they|him|her|those)\b/i.test(queryLower);
    const startsWithFollowupWord = /^(and|but|also|what about|tell me more|explain|why|how|elaborate|go deeper|give me more|what else)\b/i.test(queryLower);

    if ((wordsCount < 20 && hasPronoun) || startsWithFollowupWord) {
      let fallbackTarget = 'KB_FIRST';
      if (conversationHistory.length > 0) {
        const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMsg) {
          const prevContent = lastAssistantMsg.content.toLowerCase();
          if (/\b(restaurant|weather|score|price|news|recipe|python|javascript|react)\b/i.test(prevContent)) {
            fallbackTarget = 'WEB_ONLY';
          } else {
            fallbackTarget = 'KB_ONLY';
          }
        }
      }
      return { type: fallbackTarget, isFollowUp: true, reason: 'Follow-up query detected' };
    }

    // ── TIER 3 — LOCATION SEARCH ──
    if (/\b(near me|nearby|in my area|around me|close to me|mere paas|aas paas|local|closest)\b/i.test(queryLower)) {
      return { type: 'WEB_ONLY', isLocationSearch: true, reason: 'Location search detected' };
    }

    // ── TIER 2 — WEB SEARCH QUERIES ──
    const webTerms = [
      'latest', 'recently', 'now', 'current', 'today', 'news', '2024', '2025', '2026',
      'price', 'score', 'match', 'update', 'trending', 'who won', 'what happened',
      'new release', 'just launched', 'stock', 'weather', '\bvs\b'
    ];
    if (webTerms.some(term => new RegExp(term, 'i').test(queryLower))) {
      return { type: 'WEB_ONLY', reason: 'Time-sensitive or dynamic web search term detected' };
    }

    // ── TIER 1 — KNOWLEDGE BASE QUERIES ──
    const kbTerms = [
      'kabir panth', 'satnam', 'sant mat', 'gyan ganga', 'sant rampal', 'kabir saheb',
      'jeene ki raah', 'mukti bodh', 'quran sharif', 'bible', 'vedas', 'bhagavad gita',
      'upanishad', 'moksha', 'karma', 'salvation', 'spiritual', 'satlok'
    ];
    if (kbTerms.some(term => new RegExp('\\b' + term + '\\b', 'i').test(queryLower))) {
      return { type: 'KB_ONLY', reason: 'Explicit KB theology term detected' };
    }

    // ── TIER 4 — GENERAL KNOWLEDGE ──
    return { type: 'KB_FIRST', reason: 'General knowledge query' };
  } catch (err) {
    console.error('Classifier error:', err);
    return { type: 'KB_FIRST', reason: 'Classifier crash fallback route' };
  }
}

// ─── REVERSE GEOCODING (Nominatim) ─────────────────────────
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=16`;
    const { data } = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'TatvaAI/1.0' }
    });
    const addr = data?.address || {};
    // Try to get the most specific area name
    const areaName = addr.neighbourhood || addr.suburb || addr.village || addr.town || addr.city_district || addr.county || '';
    const city = addr.city || addr.state_district || addr.state || '';
    let result = [areaName, city].filter(Boolean).join(', ');

    // Module 1 Fix: Hardcoded spelling correction for Bhundsi typo in Nominatim
    result = result.replace(/Bhundsi/gi, "Bhondsi");

    console.log(`[Geocode] ${lat},${lon} → "${result}"`);
    return result || null;
  } catch (e) {
    console.warn('[Geocode] Nominatim failed:', e.message);
    return null;
  }
}

// ─── AI-POWERED FOLLOW-UP SUGGESTIONS ──────────────────────
async function generateAISuggestions(question, answerText) {
  if (!answerText || answerText.length < 50) return [];

  try {
    const originalQuery = question;
    const finalAnswerText = answerText;
    const suggestionPrompt = `The user asked: "${originalQuery}"\nThe answer ended with: "${finalAnswerText.slice(-300)}"\n\nGenerate exactly 3 follow-up questions that a genuinely curious person who just read that specific answer would naturally want to ask next. These must be:
- Specific to the content of that exact answer (not generic templates)
- Progressively deeper or wider than what was just covered
- Phrased as natural human questions, not formal academic ones

Return ONLY a JSON array of 3 strings. No explanation. No markdown. Example: ["Q1?", "Q2?", "Q3?"]`;

    const groq = new Groq({ apiKey: apiKeys[0] || 'dummy' });
    const suggestionRes = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: suggestionPrompt }],
      max_tokens: 120,
      temperature: 0.7
    });

    let suggestions = [];
    try {
      const raw = suggestionRes.choices[0].message.content.replace(/```json|```/g, '').trim();
      suggestions = JSON.parse(raw);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch {
      suggestions = ['Tell me more', 'Give an example', 'How does this apply practically?'];
    }
    return suggestions;
  } catch (err) {
    console.warn('Groq suggestion failed', err);
    return [];
  }
}

// ─── CONVERSATION COMPRESSION & SANITIZATION ──────────────
function sanitizeHistory(history, isToolQuery) {
  if (!history || history.length === 0) return [];
  if (isToolQuery) return history; // Allow full context for current tool queries

  const locationTerms = [/Gurgaon/gi, /Bhondsi/gi, /Delhi/gi, /Haryana/gi, /Noida/gi, /Faridabad/gi, /Mumbai/gi, /Bangalore/gi];

  return history.map(m => {
    let content = m.content || '';
    // Scrub specific cities
    locationTerms.forEach(term => {
      content = content.replace(term, '[Location Data Redacted]');
    });
    // Scrub list-like map data
    if (content.includes('meters away') || content.includes('Current weather in')) {
      content = '[Previous Location/Weather Data Redacted for Privacy]';
    }
    return { ...m, content };
  });
}

function compressHistory(history) {
  if (!history || history.length === 0) return [];
  if (history.length <= 6) return history.slice(-6);

  const recent = history.slice(-6);  // keep last 6 verbatim
  const older = history.slice(0, -6);

  if (older.length === 0) return recent;

  // Create compressed summary of older messages
  const summary = older
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => (m.content || '').substring(0, 100))
    .join(' | ');

  const compressed = {
    role: 'system',
    content: `[Earlier conversation topics: ${summary}]`
  };

  return [compressed, ...recent].map(m => ({
    role: m.role,
    content: (m.content || '').substring(0, 500)
  }));
}

// ─── WEATHER & PLACES INTEGRATION ────────────────────────────
async function fetchWeather(lat, lon) {
  if (!process.env.OPENWEATHER_API_KEY) {
    return [{ text: `WeatherAPI key is missing.`, title: "System Note", type: 'web' }];
  }
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${process.env.OPENWEATHER_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const info = `Current weather in ${data.name}: ${data.weather[0].description}, Temp: ${data.main.temp}°C (Feels like ${data.main.feels_like}°C), Humidity: ${data.main.humidity}%`;
    return [{ text: info, title: `Weather Context`, url: "https://openweathermap.org", domain: "openweathermap.org", favicon: "https://openweathermap.org/favicon.ico", type: 'web' }];
  } catch (e) {
    console.log("WEATHER API ERROR:", e.response?.data || e.message);
    return [];
  }
}

async function fetchPlaces(latInput, lonInput, userQuery) {
  // Guard: validate coordinates
  const lat = parseFloat(latInput);
  const lon = parseFloat(lonInput);
  if (isNaN(lat) || isNaN(lon) || lat === 0 || lon === 0) {
    return [{ text: 'Location access chahiye nearby results ke liye. Browser mein allow karke dobara try karo.', title: "System Note", type: 'web' }];
  }
  console.log('[TATVA LOCATION] Valid coords received:', { lat, lon });

  // Clean the user query — strip location phrases
  const locationPhrases = /\b(near me|nearby|in my area|around me|close to me|mere paas|aas paas|near by|nearest|closest)\b/gi;
  const cleanedQuery = userQuery
    .replace(locationPhrases, '')
    .replace(/\s+/g, ' ')
    .trim();
  console.log('[TATVA LOCATION] Cleaned query for API:', cleanedQuery);

  // Reverse geocode to get neighborhood name
  let neighborhood = 'your area';
  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const geoRes = await fetch(nominatimUrl, {
      headers: { 'User-Agent': 'TatvaAI/1.0 (contact@tatva.ai)' }
    });
    const geoData = await geoRes.json();
    neighborhood = geoData?.address?.suburb
      || geoData?.address?.neighbourhood
      || geoData?.address?.city_district
      || geoData?.address?.town
      || geoData?.address?.city
      || 'your area';
    console.log('[TATVA LOCATION] Neighborhood resolved:', neighborhood);
  } catch (e) { }

  // Foursquare API call
  try {
    const fsqUrl = `https://api.foursquare.com/v3/places/search?query=${encodeURIComponent(cleanedQuery)}&ll=${lat},${lon}&radius=10000&limit=8&fields=name,location,categories,distance`;
    const fsqRes = await fetch(fsqUrl, {
      headers: {
        'Authorization': process.env.FOURSQUARE_API_KEY,
        'Accept': 'application/json'
      }
    });
    const fsqData = await fsqRes.json();

    if (!fsqData.results || fsqData.results.length === 0) {
      return [{ text: `${neighborhood} ke 10km mein koi ${cleanedQuery} nahi mili. Google Maps pe directly try karo — wahan zyada results honge.`, title: "System Note", type: 'web' }];
    }

    // Format results as clean numbered list
    const formattedResults = fsqData.results.map((place, i) => {
      const address = [
        place.location?.address,
        place.location?.locality,
        place.location?.region
      ].filter(Boolean).join(', ') || 'Address not available';
      const category = place.categories?.[0]?.name || 'Location';
      const distanceKm = place.distance ? (place.distance / 1000).toFixed(1) : '';
      return `${i + 1}. ${place.name} — ${address} | ${distanceKm} km door`;
    }).join('\n');

    const finalAnswer = `Aapke paas ${neighborhood} mein ${cleanedQuery} yahan hain:\n${formattedResults}`;
    return [{ text: finalAnswer, title: `Nearby ${cleanedQuery} via Foursquare`, url: 'https://foursquare.com', domain: 'foursquare.com', type: 'web' }];
  } catch (e) {
    console.error("FOURSQUARE API ERROR:", e.message);
    return [];
  }
}

// ─── WEB SEARCH (returns structured results with URLs) ─────
async function searchWeb(query, coords = null, areaName = null) {
  // If location/weather query and coords/areaName exist, use real deterministic APIs instead of scraping DuckDuckGo!
  const isWeather = /\\b(weather|mausam|temperature|barish|forecast|climate)\\b/i.test(query);
  const isPlaces = /(?:restaurant|dhaba|cafe|hotel|hospital|atm|petrol pump|gas station|pharmacy|shop|store|market|mall|near me|nearby)/i.test(query);

  if (isWeather && areaName) {
    return await fetchWeather(areaName);
  }
  if (isPlaces && coords) {
    // Extract base subject, e.g. "cafes near me" -> "cafe"
    const cleanQuery = query.replace(/(?:near me|nearby|around me|mere paas|mere aas paas|in my area)/gi, '').trim() || 'places';
    return await fetchPlaces(coords.latitude, coords.longitude, cleanQuery);
  }

  // Fallback to DuckDuckGo strictly for general web facts
  let searchQuery = query;
  if (areaName) {
    // Replace "near me" / "nearby" etc. with the actual area name
    searchQuery = query.replace(/(?:near me|nearby|mere paas|mere aas paas|closest|nearest|around me|mere area|my area|my location|mera area)/gi, `in ${areaName}`);
    // If no replacement happened (e.g. weather query without "near me"), append the area
    if (searchQuery === query) {
      searchQuery = `${query} in ${areaName}`;
    }
    console.log(`[Search] Location-enhanced query: "${searchQuery}"`);
  }

  const endpoints = [
    `https://ddg-webapp-aagd.vercel.app/search?q=${encodeURIComponent(searchQuery)}&max=8`,
    `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_html=1&skip_disambig=1`
  ]
  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { timeout: 7000 })
      if (Array.isArray(data?.results) && data.results.length > 0) {
        return data.results.slice(0, 6).map(r => ({
          text: r.body || r.snippet || r.Text || '',
          url: r.href || r.url || null,
          title: r.title || 'Web Result',
          domain: (r.href || r.url) ? (() => { try { return new URL(r.href || r.url).hostname.replace('www.', ''); } catch (e) { return null; } })() : null,
          type: 'web'
        }));
      }
    } catch (e) {
      console.log('[Search] Endpoint failed:', e.message);
    }
  }
  return [];
}

// ============================================
// CONFIDENCE-BASED RETRIEVAL SYSTEM
// ============================================
const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.60,    // Direct answer found — use as primary source
  MEDIUM: 0.45,  // Related context found — use with inference note  
  LOW: 0.30,     // Weak match — use carefully, flag to LLM
  NONE: 0.30     // Below this — tell LLM no relevant context found
};

function getConfidenceLevel(similarity) {
  if (similarity >= CONFIDENCE_THRESHOLDS.HIGH) return "HIGH";
  if (similarity >= CONFIDENCE_THRESHOLDS.MEDIUM) return "MEDIUM";
  if (similarity >= CONFIDENCE_THRESHOLDS.LOW) return "LOW";
  return "NONE";
}

// ═══════════════════════════════════════════════════════
// LIGHTWEIGHT QUERY EXPANSION (no LLM call needed)
// ═══════════════════════════════════════════════════════
function expandQueryLocal(originalQuery) {
  const queries = [originalQuery];
  let q = originalQuery.toLowerCase().trim();

  // ── Step 0: Spelling corrections & common typos ──
  const corrections = {
    'guns': 'gunas', 'gun': 'guna',
    'mahakala': 'mahakal', 'mahakalas': 'mahakal',
    'moksh': 'moksha', 'moks': 'moksha',
    'satlog': 'satlok', 'sachkand': 'sachkhand',
    'kabeer': 'kabir', 'kabirr': 'kabir',
    'kundlini': 'kundalini', 'kundalani': 'kundalini',
    'bhagwat': 'bhagavad', 'geeta': 'gita',
    'shiv': 'shiva', 'vishu': 'vishnu', 'vishno': 'vishnu',
    'bramha': 'brahma', 'bramh': 'brahm',
    'triydev': 'tridev', 'trimurti': 'trinity',
    'sakti': 'shakti', 'shakthi': 'shakti',
    // Common name misspellings
    'sev': 'seu', 'saman': 'samman',
    'garibdas': 'garibdas', 'gareebdas': 'garibdas',
    'ramanand': 'ramanand', 'ramanad': 'ramanand',
    'dharamdas': 'dharamdas', 'dharmdas': 'dharamdas',
    'prahlad': 'prahlad', 'prahalad': 'prahlad',
    'naamdev': 'namdev', 'namdeo': 'namdev',
    'ravidas': 'ravidas', 'ravidaas': 'ravidas',
    'dadu': 'dadu', 'dadoo': 'dadu',
    'pipa': 'pipa', 'pepa': 'pipa', 'peepa': 'pipa',
    'ajamil': 'ajamil', 'ajaamal': 'ajamil',
  };
  let correctedQ = q;
  for (const [wrong, right] of Object.entries(corrections)) {
    if (correctedQ.includes(wrong)) {
      correctedQ = correctedQ.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
    }
  }
  if (correctedQ !== q) {
    queries.push(correctedQ);
  }

  // ── Step 1: Synonym map for spiritual terms ──
  const synonyms = {
    'kaal': ['brahm', 'jyoti niranjan', 'kshar purush'],
    'brahm': ['kaal', 'jyoti niranjan'],
    'satpurush': ['akal purakh', 'param akshar brahm', 'kabir sahib', 'kavirdev'],
    'satlok': ['sach khand', 'amarlok', 'sachkhand'],
    'kabir': ['kavirdev', 'sat sukrat', 'karunamayi', 'supreme god'],
    'satnam': ['sat naam', 'true mantra', 'two syllable mantra'],
    'sarnaam': ['sar naam', 'ultimate mantra', 'final mantra'],
    'moksha': ['salvation', 'liberation', 'mukti'],
    'mukti': ['moksha', 'salvation'],
    'durga': ['ashtangi', 'maya', 'prakriti'],
    'guru': ['satguru', 'spiritual master', 'tatvadarshi'],
    'mahakal': ['kala', 'kalas', '16 kalas', 'divine arts'],
    'kala': ['kalas', 'kalaas', 'divine arts', 'mahakal gunas'],
    'gunas': ['guna', 'qualities', 'attributes'],
    'vishnu': ['shri vishnu', 'lord vishnu', 'vishnu ji'],
    'shiva': ['shiv', 'shankar', 'mahadev', 'bholenath'],
    'brahma': ['brahma ji', 'creator brahma'],
    'gita': ['bhagavad gita', 'shrimad bhagavad gita'],
    'pitra': ['pitras', 'ancestor ghost', 'ancestor worship'],
    'kundalini': ['serpent power', 'kundlini'],
    'chakra': ['chakras', 'kamal', 'lotus'],
    'naam': ['mantra', 'naam daan'],
    'trinity': ['tridev', 'brahma vishnu shiva'],
    'dharamraj': ['dharamraaj', 'judge of death', 'yam raj'],
  };

  // Apply ALL matching synonyms (not just first)
  const workQ = correctedQ || q;
  let combinedVariant = workQ; // Build one variant with all replacements
  for (const [term, syns] of Object.entries(synonyms)) {
    if (workQ.includes(term)) {
      // Add individual variants with first synonym
      queries.push(workQ.replace(new RegExp(term, 'gi'), syns[0]));
      // Update combined variant
      combinedVariant = combinedVariant.replace(new RegExp(term, 'gi'), syns[0]);
    }
  }
  if (combinedVariant !== workQ) {
    queries.push(combinedVariant);
  }

  // ── Step 1.5: Semantic rewrite patterns ──
  // These transform user phrasing into forms that better match QA bank entries
  const rewrites = [
    { match: /mahakal|mahakala|16.*kala|kala.*16/i, add: 'kalas vishnu kaal power difference' },
    { match: /tridev|trinity.*trap/i, add: 'brahma vishnu shiva trap kaal' },
    { match: /srishti.*rachana|creation.*universe/i, add: 'how universe created kaal satlok' },
    { match: /garbh.*vaas|womb.*trap|birth.*suffering/i, add: 'soul suffering womb garbh 9 months' },
    { match: /bhanwar.*gufa|whirlpool.*cave/i, add: 'bhanwar gufa spinning vortex soul' },
    { match: /dasam.*dwaar|tenth.*door/i, add: 'dasam dwaar tenth door crown chakra' },
    { match: /pativrata|loyal.*devotee/i, add: 'pativrata bhakt devotion loyalty satguru' },
    { match: /chaurasi|84.*lakh|8.4.*million/i, add: 'chaurasi lakh yoni 8.4 million species cycle' },
    { match: /seu|samman|nekee|sev.*saman/i, add: 'seu samman nekee merchant flour kabir salvation story' },
    { match: /garibdas.*kabir|kabir.*garibdas/i, add: 'garibdas 10 years cattle field jinda mahatma cow milk satlok' },
    { match: /ranka.*banka|banka.*ranka/i, add: 'ranka banka devotees detachment wealth guru test' },
    { match: /sadna.*kasai|butcher.*saint/i, add: 'sadna kasai butcher devotee meat goat miracle' },
    { match: /ajamil|ajaamal/i, add: 'ajamil sinful brahmin son narayan yam doot vishnu rescue' },
  ];
  for (const r of rewrites) {
    if (r.match.test(workQ)) {
      queries.push(r.add);
    }
  }

  // ── Step 1.6: Hindi ↔ English concept bridges ──
  // Many users ask in Hindi but QA bank has English answers, or vice versa
  const hindiBridges = [
    { match: /sabse\s+bada\s+paap|biggest\s+sin/i, add: 'ultimate sin meat eating violence' },
    { match: /manushya\s+janam|human\s+birth|insaan.*janam/i, add: 'significance human body manushya janam diamond' },
    { match: /sachcha\s+guru|true\s+guru|asli.*guru/i, add: 'tatvadarshi satguru true saint guru recognize identify' },
    { match: /mrityu|death|maut/i, add: 'soul death yamdhoots satguru protection' },
    { match: /paap.*karma|karma.*paap|sin.*karma/i, add: 'karma paap punya sanchit prarabdha kriyaman' },
    { match: /param.*akshar|supreme.*god|sabse.*bada.*bhagwan/i, add: 'param akshar purush supreme god kabir kavirdev' },
    { match: /roop|form.*god|god.*form|bhagwan.*roop/i, add: 'is god formless nirgun sagun physical form divine light noor' },
    { match: /kaal\s+kaun|who\s+is\s+kaal|kaal\s+kya/i, add: 'kaal brahm jyoti niranjan ruler 21 universes trap' },
    { match: /durga\s+kaun|who\s+is\s+durga|durga\s+kya/i, add: 'durga ashtangi maya prakriti mother trinity' },
    { match: /satlok\s+kya|what\s+is\s+satlok|satlok.*kaise/i, add: 'satlok eternal realm sachkhand immortal abode supreme god' },
    { match: /mukti|liberation|salvation|chutkara/i, add: 'moksha liberation salvation mukti escape cycle birth death' },
    { match: /naam.*daan|mantra.*initiation/i, add: 'naam daan spiritual initiation satnam sarnaam sequence' },
    { match: /bhagavad\s+gita|gita.*kya|gita.*kaun/i, add: 'gita speaker kaal brahm krishna arjuna supreme god reference' },
    { match: /quran|islam.*kabir|kabir.*quran/i, add: 'quran kabiran supreme creator surah furqan allah kabir' },
    { match: /bible|jesus|isa/i, add: 'bible jesus christ parampita supreme father salvation satlok' },
    { match: /ved|veda|vedas/i, add: 'vedas yajurveda atharvaveda kavirdev supreme god kabir' },
    { match: /guru.*granth|sikh|nanak/i, add: 'guru granth sahib nanak hakka kabir satguru sachkhand' },
    { match: /sharab|alcohol|nashe|intoxic/i, add: 'alcohol intoxicants surati spiritual damage rebirth' },
    { match: /mans|meat|non.*veg|maas/i, add: 'meat eating sin karmic debt animal slaughter rebirth' },
    { match: /panch.*chor|five.*thieves/i, add: 'five thieves panch chor kaam krodh lobh moh ahankar' },
    { match: /trikuti|third.*eye|teesra.*netra/i, add: 'trikuti third eye ajna chakra mind kaal control room' },
    { match: /sahasrar|crown.*chakra/i, add: 'sahasrara crown lotus 1000 petals kaal capital brahmaloka' },
    { match: /kundalini|kundlini|serpent.*power/i, add: 'kundalini serpent power danger guru madness illness' },
    { match: /swarg|heaven|narak|hell/i, add: 'heaven hell temporary not permanent kaal trap rebirth' },
    { match: /bhoot|ghost|pitra|ancestor/i, add: 'ghost pitra ancestor worship shradh liberation satguru' },
    { match: /jeene\s+ki\s+raah|jeene\s+ki\s+rah|way\s+of\s+living|jeene-ki-rah/i, add: 'jeene ki raah जीने की राह लेखक संत रामपाल जी महाराज book writer author thus dh jkg ys[kd lar jkeiky' },
    { match: /peepa|pipa|king\s+pipa|raja\s+pipa/i, add: 'peepa pipa bhagat पीपा राजा पीपा वाणी पीपा जी की' },
    { match: /gita.*4:34|gita.*4\s+verse\s+34|gita.*chapter\s+4\s+verse\s+34/i, add: 'Who is the Tatvadarshi Sant mentioned in Gita 4:34? Tatvadarshi' }
  ];
  for (const hb of hindiBridges) {
    if (hb.match.test(workQ)) {
      queries.push(hb.add);
    }
  }

  // ── Step 2: Entity-only variant (strip question words) ──
  const entityOnly = workQ
    .replace(/\b(what|who|how|why|when|where|which|is|are|was|were|did|does|do|can|tell|me|about|the|a|an|of|in|from|for|to|and|or|by|with|this|that|it|those|these)\b/gi, '')
    .replace(/[?.,!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (entityOnly && entityOnly !== workQ && entityOnly.length > 3) {
    queries.push(entityOnly);
  }

  return [...new Set(queries)].slice(0, 8);
}

function isBroadQuery(query) {
  return /^(how many|what is|explain|describe|what are|who is|tell me about|list|kya hai|kaise|kitne|kaun|body layers|souls layers)/i.test(query.trim());
}

// ═══════════════════════════════════════════════════════
// GENERAL DEVANAGARI ↔ ROMAN TRANSLITERATION & FUZZY MATCHING
// Works for ANY entity name — no hardcoded lookup tables.
// ═══════════════════════════════════════════════════════

// Complete Devanagari → Latin phonetic mapping (full Unicode block U+0900-U+097F)
const DEVANAGARI_TO_LATIN = {
  // Vowels
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
  // Vowel matras
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n', 'ः': 'h',
  'ँ': 'n', '्': '',
  // Consonants
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h',
  // Nukta variants
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh',
  'फ़': 'f',
  // Digits
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
};

/**
 * Transliterate Devanagari text to Latin phonetic form.
 * General: covers the full Devanagari Unicode block, not a lookup table.
 */
function transliterateToLatin(text) {
  if (!text) return '';
  let result = '';
  const chars = [...text]; // proper Unicode iteration
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (DEVANAGARI_TO_LATIN[ch] !== undefined) {
      result += DEVANAGARI_TO_LATIN[ch];
    } else if (ch === '्') {
      continue; // halant: suppress inherent vowel
    } else {
      result += ch;
    }
  }
  return result.toLowerCase();
}

/**
 * Normalize Indic/Hinglish spelling variants to a canonical form.
 * General rules only — no entity-specific entries.
 */
function normalizeIndic(word) {
  if (!word) return '';
  return word.toLowerCase()
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/th/g, 't')
    .replace(/ksh/g, 'ks')
    .replace(/(.)\1+/g, '$1')
    .replace(/[aeiou]$/g, '');
}

/**
 * Jaro-Winkler string similarity — general algorithm, no lookup tables.
 * Returns 0.0 (no match) to 1.0 (exact match).
 */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1.length || !s2.length) return 0.0;

  const maxDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  if (maxDist < 0) return s1 === s2 ? 1.0 : 0.0;

  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end = Math.min(i + maxDist + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * General fuzzy entity matching: works for ANY Indic entity name.
 * Pipeline: exact substring → transliteration → normalization → Jaro-Winkler (≥0.85)
 */
function indicFuzzyMatch(queryEntity, chunkText) {
  const cleanQ = queryEntity.toLowerCase().trim();
  const cleanDoc = chunkText.toLowerCase();

  // 1. Exact substring match
  if (cleanDoc.includes(cleanQ)) return true;
  // 2. Word-boundary regex match
  try { if (new RegExp(`\\b${cleanQ}`, 'i').test(chunkText)) return true; } catch(e) {}
  // 3. Transliterate Devanagari in both sides, then check inclusion
  const transQ = transliterateToLatin(cleanQ);
  const transDoc = transliterateToLatin(cleanDoc);
  if (transQ.length >= 3 && transDoc.includes(transQ)) return true;
  // 4. Normalize Hinglish variants, then check inclusion
  const normQ = normalizeIndic(transQ || cleanQ);
  if (normQ.length < 3) return false;
  const normDoc = normalizeIndic(transDoc || cleanDoc);
  if (normDoc.includes(normQ)) return true;
  // 5. Jaro-Winkler on individual words (≥0.85 threshold)
  const docWords = cleanDoc.split(/\s+/);
  for (const word of docWords) {
    const normWord = normalizeIndic(transliterateToLatin(word));
    if (normWord.length < 3) continue;
    if (jaroWinkler(normQ, normWord) >= 0.85) return true;
  }
  return false;
}

/**
 * Extract key entities from a query using the shared STOPWORDS set.
 */
function extractQueryEntities(query) {
  return query.toLowerCase()
    .replace(/[?.,!\"']/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ═══════════════════════════════════════════════════════
// COSINE SIMILARITY HELPER (ChromaDB cosine distance → similarity)
// ChromaDB cosine distance = 1 - cos_sim, ranges 0 (identical) to 2 (opposite)
// ═══════════════════════════════════════════════════════
function cosineDistToSim(distance) {
  if (distance == null || distance >= 999) return 0;
  return Math.max(0, 1 - (distance / 2));
}

// RECIPROCAL RANK FUSION (RRF) — merge dense + sparse rankings
// score = Σ 1/(k + rank_i) across all ranking lists
// ═══════════════════════════════════════════════════════
function reciprocalRankFusion(rankings, k = 60) {
  const scores = new Map(); // docKey -> { score, data }
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      const key = item.docKey || item.doc.substring(0, 120);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { score: rrfScore, ...item });
      }
    });
  }
  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════
// STAGE 1: QA PRECISION LOOKUP (dedicated collection + BM25)
// ═══════════════════════════════════════════════════════
async function searchQABank(originalQuery) {
  if (!chromaQACollection) return { qaChunks: [], qaTopScore: 0 };

  try {
    const queries = expandQueryLocal(originalQuery);
    console.log(`[QA] Searching with ${queries.length} variants`);

    const nResults = isBroadQuery(originalQuery) ? 15 : 10;
    const results = await chromaQACollection.query({
      queryTexts: queries,
      nResults: nResults,
      include: ['documents', 'distances', 'metadatas']
    });

    // Build dense ranking from vector results
    const denseMap = new Map();
    queries.forEach((q, queryIdx) => {
      const docs = results.documents?.[queryIdx] || [];
      const distances = results.distances?.[queryIdx] || [];
      const metadatas = results.metadatas?.[queryIdx] || [];
      docs.forEach((doc, i) => {
        const qaNum = metadatas[i]?.qa_num || metadatas[i]?.source || doc.substring(0, 50);
        const vectorSim = cosineDistToSim(distances[i]);
        const existing = denseMap.get(qaNum);
        if (!existing || vectorSim > existing.vectorSim) {
          denseMap.set(qaNum, {
            doc, vectorSim, meta: metadatas[i] ?? {}, sourceType: 'qa', docKey: qaNum
          });
        }
      });
    });
    const denseRanking = Array.from(denseMap.values()).sort((a, b) => b.vectorSim - a.vectorSim);

    // Build sparse ranking from BM25
    let sparseRanking = [];
    if (bm25QA.ready) {
      const bm25Results = bm25QA.search(originalQuery, 20);
      sparseRanking = bm25Results.map(r => ({
        doc: r.text, bm25Score: r.bm25Score, meta: r.meta || {}, sourceType: 'qa',
        docKey: r.meta?.qa_num || r.meta?.source || r.text.substring(0, 50)
      }));
    }

    // Fuse with RRF
    const fused = reciprocalRankFusion([denseRanking, sparseRanking]);

    // Enrich with vector similarity for downstream scoring
    const qaChunks = fused.slice(0, isBroadQuery(originalQuery) ? 8 : 6).map(item => {
      const denseData = denseMap.get(item.docKey);
      const vectorSim = denseData?.vectorSim || item.vectorSim || 0;
      return {
        doc: item.doc,
        similarity: item.score, // RRF score
        vectorSim,
        rrfScore: item.score,
        confidence: getConfidenceLevel(vectorSim),
        meta: item.meta || {},
        sourceType: 'qa'
      };
    });

    const qaTopScore = qaChunks[0]?.vectorSim || 0;
    qaChunks.slice(0, 3).forEach((c, i) => {
      console.log(`[QA] #${i + 1} | RRF: ${c.rrfScore.toFixed(4)} vec: ${c.vectorSim.toFixed(3)} | Q: ${(c.meta?.question || c.doc).substring(0, 80)}...`);
    });
    console.log(`[QA] Found ${qaChunks.length} Q&A candidates (top vec: ${qaTopScore.toFixed(3)})`);

    return { qaChunks, qaTopScore };
  } catch (e) {
    console.error('[QA] Search error:', e.message);
    return { qaChunks: [], qaTopScore: 0 };
  }
}

// ═══════════════════════════════════════════════════════
// STAGE 2: KB VECTOR + BM25 HYBRID SEARCH
// ═══════════════════════════════════════════════════════
async function searchKBChunks(originalQuery) {
  if (!chromaReady || !chromaCollection) return { kbChunks: [], kbTopScore: 0 };

  try {
    const queries = expandQueryLocal(originalQuery);

    const nResults = isBroadQuery(originalQuery) ? 35 : 20;
    const results = await chromaCollection.query({
      queryTexts: queries,
      nResults: nResults,
      include: ['documents', 'distances', 'metadatas']
    });

    // Build dense ranking with deduplication
    let seenDocs = new Set();
    const denseRanking = [];

    queries.forEach((q, queryIdx) => {
      const docs = results.documents?.[queryIdx] || [];
      const distances = results.distances?.[queryIdx] || [];
      const metadatas = results.metadatas?.[queryIdx] || [];
      docs.forEach((doc, i) => {
        if (doc.length < 40) return;
        const docWords = new Set(doc.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let isDuplicate = false;
        for (const seen of seenDocs) {
          const seenWords = new Set(seen.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const overlap = [...docWords].filter(w => seenWords.has(w)).length;
          if (overlap / Math.max(docWords.size, 1) > 0.50) { isDuplicate = true; break; }
        }
        if (!isDuplicate) {
          seenDocs.add(doc);
          const vectorSim = cosineDistToSim(distances[i]);
          const sourceTier = metadatas[i]?.source_tier || 2;
          const tierBoost = sourceTier === 1 ? 1.1 : 1.0; // Reduced from 1.3 — reranker handles relevance now
          denseRanking.push({
            doc, vectorSim: vectorSim * tierBoost, sourceTier,
            meta: metadatas[i] ?? {}, sourceType: metadatas[i]?.type || 'pdf',
            docKey: doc.substring(0, 120)
          });
        }
      });
    });
    denseRanking.sort((a, b) => b.vectorSim - a.vectorSim);

    // Build sparse ranking from BM25
    let sparseRanking = [];
    if (bm25KB.ready) {
      const bm25Results = bm25KB.search(originalQuery, 30);
      sparseRanking = bm25Results.map(r => ({
        doc: r.text, bm25Score: r.bm25Score, meta: r.meta || {},
        sourceType: r.meta?.type || 'pdf', docKey: r.text.substring(0, 120)
      }));
    }

    // Fuse with RRF
    const fused = reciprocalRankFusion([denseRanking, sparseRanking]);

    // Entity boosting using general fuzzy match (no corrections map needed)
    const queryEntities = extractQueryEntities(originalQuery);
    const candidateChunks = fused.map(item => {
      const denseData = denseRanking.find(d => d.docKey === item.docKey);
      const vectorSim = denseData?.vectorSim || item.vectorSim || 0;
      // Entity boost: if chunk contains query entities (via fuzzy match), boost
      let entityBoost = 0;
      if (queryEntities.length > 0) {
        const hits = queryEntities.filter(e => indicFuzzyMatch(e, item.doc)).length;
        entityBoost = (hits / queryEntities.length) * 0.005; // Small RRF-scale boost
      }
      return {
        doc: item.doc, similarity: vectorSim, rrfScore: item.score + entityBoost,
        vectorSim, sourceTier: denseData?.sourceTier || 2,
        confidence: getConfidenceLevel(vectorSim),
        meta: item.meta || {}, sourceType: item.sourceType || 'pdf'
      };
    });
    candidateChunks.sort((a, b) => b.rrfScore - a.rrfScore);

    // Source diversity enforcement: limit fraction from a single source file
    const MAX_SOURCE_FRACTION = 0.6;
    const targetLimit = isBroadQuery(originalQuery) ? 12 : 8;
    const maxPerSource = Math.max(2, Math.ceil(targetLimit * MAX_SOURCE_FRACTION));
    const diversified = [];
    const sourceCounts = {};
    const addedDocs = new Set();

    for (const chunk of candidateChunks) {
      if (diversified.length >= targetLimit) break;
      const srcFile = (chunk.meta?.source || 'unknown').toLowerCase();
      sourceCounts[srcFile] = (sourceCounts[srcFile] || 0) + 1;
      if (sourceCounts[srcFile] <= maxPerSource) {
        diversified.push(chunk);
        addedDocs.add(chunk.doc);
      }
    }

    // Backfill if diversified is too small
    if (diversified.length < targetLimit) {
      for (const chunk of candidateChunks) {
        if (diversified.length >= targetLimit) break;
        if (!addedDocs.has(chunk.doc)) {
          diversified.push(chunk);
          addedDocs.add(chunk.doc);
        }
      }
    }
    const kbChunks = diversified;

    const kbTopScore = kbChunks[0]?.vectorSim || 0;
    kbChunks.slice(0, 3).forEach((c, i) => {
      console.log(`[KB] #${i + 1} | RRF: ${c.rrfScore.toFixed(4)} vec: ${c.vectorSim.toFixed(3)} | Src: ${(c.meta?.source || 'KB').substring(0, 50)} | "${c.doc.substring(0, 80)}..."`);
    });
    console.log(`[KB] Found ${kbChunks.length} KB chunks (top vec: ${kbTopScore.toFixed(3)})`);

    return { kbChunks, kbTopScore };
  } catch (e) {
    console.error('[KB] Search error:', e.message);
    return { kbChunks: [], kbTopScore: 0 };
  }
}

// ═══════════════════════════════════════════════════════
// QUERY INTENT ANALYZER (Groq llama-3.1-8b-instant)
// Classifies query type, extracts key requirements, and decomposes if needed.
// ═══════════════════════════════════════════════════════
async function analyzeQueryIntent(query, conversationHistory = []) {
  if (!apiKeys.length) {
    return {
      question_type: "factual",
      answer_requirements: query,
      needs_decomposition: false,
      sub_queries: []
    };
  }

  try {
    const prompt = `Analyze the user query and output a JSON object representing the query intent.
Query: "${query}"

Return JSON matching this schema:
{
  "question_type": "factual" | "how_mechanism" | "comparison" | "count_or_list" | "relational" | "opinion_or_interpretation",
  "answer_requirements": "short description of what a complete answer needs to cover",
  "needs_decomposition": boolean,
  "sub_queries": ["sub query 1", "sub query 2"] // up to 3 sub-queries, only if needs_decomposition is true, otherwise empty array
}

JSON object only:`;

    const groq = new Groq({ apiKey: apiKeys[Math.floor(Math.random() * apiKeys.length)] });
    const startTime = Date.now();
    const res = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0.0,
      response_format: { type: "json_object" }
    });
    const latency = Date.now() - startTime;
    console.log(`[Intent] Analyzed intent in ${latency}ms`);

    const raw = res.choices[0]?.message?.content?.trim() || '{}';
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[Intent] Analysis failed: ${err.message}`);
    return {
      question_type: "factual",
      answer_requirements: query,
      needs_decomposition: false,
      sub_queries: []
    };
  }
}

// ═══════════════════════════════════════════════════════
// LIGHTWEIGHT LLM RERANK (Groq llama-3.1-8b-instant)
// Scores top ~20 candidates for relevance, keeps top 6-10.
// Graceful degradation: if Groq fails, skip rerank.
// ═══════════════════════════════════════════════════════
async function rerankWithLLM(query, candidates, topK = 8, intent = null) {
  if (!candidates.length || !apiKeys.length) return { reranked: candidates.slice(0, topK), sufficiencyScore: 1.0 };

  try {
    // Truncate passages to keep prompt small
    const passages = candidates.slice(0, 25).map((c, i) =>
      `[${i + 1}] ${c.doc.substring(0, 200).replace(/\n/g, ' ')}`
    ).join('\n');

    const reqs = intent?.answer_requirements || query;
    const prompt = `You are a precision search validator. Rate how well each retrieved passage answers the specific question requirements.
Question: "${query}"
Specific Answer Requirements: "${reqs}"

Passages to rate:
${passages}

Rating Rules:
- Rate from 0 to 10.
- A passage that directly and fully contains the answer or critical fact requested should score 8-10.
- A passage that is topically adjacent (talks about the entities or related context) but does NOT answer the specific question asked should score 0-3.
- If a passage is completely irrelevant, score it 0.

Return JSON in this format:
{
  "scores": [number, number, ...] // one rating integer (0-10) per passage
}

JSON object only:`;

    const groq = new Groq({ apiKey: apiKeys[Math.floor(Math.random() * apiKeys.length)] });
    const startTime = Date.now();
    const res = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0.0,
      response_format: { type: "json_object" }
    });
    const latency = Date.now() - startTime;
    console.log(`[Rerank] Scored passages in ${latency}ms`);

    const raw = res.choices[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw);
    const scores = parsed.scores || [];

    const reranked = candidates.slice(0, 25).map((c, i) => ({
      ...c,
      rerankScore: (scores[i] || 0) / 10, // normalize to 0-1
      finalScore: (c.rrfScore || c.similarity || 0) * 0.4 + ((scores[i] || 0) / 10) * 0.6
    }));

    reranked.sort((a, b) => b.finalScore - a.finalScore);
    const maxScore = Math.max(...(scores.length ? scores : [0])) / 10;
    console.log(`[Rerank] LLM scored ${scores.length} passages. Top: ${reranked[0]?.finalScore?.toFixed(3)} | Sufficiency Score: ${maxScore}`);

    return {
      reranked: reranked.slice(0, topK),
      sufficiencyScore: maxScore
    };

  } catch (err) {
    console.warn(`[Rerank] Groq call failed (${err.message}), using hybrid scores as fallback`);
    return {
      reranked: candidates.slice(0, topK),
      sufficiencyScore: 1.0
    };
  }
}

// ═══════════════════════════════════════════════════════
// MASTER RETRIEVAL: QA + KB + BM25 + RERANK + SOFT ENTITY VERIFICATION
// ═══════════════════════════════════════════════════════
async function searchDatabase(originalQuery) {
  if (!chromaReady || !chromaCollection) {
    console.log('[RAG] ChromaDB not ready');
    return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery], intent: null };
  }

  try {
    // Intent & Answer Requirement Analysis
    const intent = await analyzeQueryIntent(originalQuery);
    console.log(`[Intent] Intent analyzed: type=${intent.question_type}, needs_decomp=${intent.needs_decomposition}`);

    let qaChunks = [];
    let kbChunks = [];
    let qaTopScore = 0;
    let kbTopScore = 0;

    if (intent.needs_decomposition && intent.sub_queries && intent.sub_queries.length > 0) {
      console.log(`[RAG] Decomposing query into: ${intent.sub_queries.join(', ')}`);
      const subQueries = intent.sub_queries.slice(0, 3);
      const qaResults = await Promise.all(subQueries.map(q => searchQABank(q)));
      const kbResults = await Promise.all(subQueries.map(q => searchKBChunks(q)));

      const seenQA = new Set();
      for (const res of qaResults) {
        qaTopScore = Math.max(qaTopScore, res.qaTopScore);
        for (const chunk of res.qaChunks) {
          const fp = chunk.doc.substring(0, 100).toLowerCase();
          if (!seenQA.has(fp)) {
            seenQA.add(fp);
            qaChunks.push(chunk);
          }
        }
      }

      const seenKB = new Set();
      for (const res of kbResults) {
        kbTopScore = Math.max(kbTopScore, res.kbTopScore);
        for (const chunk of res.kbChunks) {
          const fp = chunk.doc.substring(0, 100).toLowerCase();
          if (!seenKB.has(fp)) {
            seenKB.add(fp);
            kbChunks.push(chunk);
          }
        }
      }

      // Filter sub-query results using RRF_NOISE_FLOOR (0.012) to remove junk sub-query context
      const RRF_NOISE_FLOOR = 0.012;
      const beforeFilterCount = kbChunks.length;
      const filteredKB = kbChunks.filter(c => (c.rrfScore || 0) >= RRF_NOISE_FLOOR);

      if (filteredKB.length > 0) {
        kbChunks = filteredKB;
        console.log(`[RAG] Sub-query RRF noise filter: kept ${kbChunks.length}/${beforeFilterCount} chunks (floor: ${RRF_NOISE_FLOOR})`);
      } else if (kbChunks.length > 0) {
        // Safe fallback to top 2 chunks if all were below threshold to avoid false-NONE
        kbChunks.sort((a, b) => (b.rrfScore || 0) - (a.rrfScore || 0));
        kbChunks = kbChunks.slice(0, 2);
        console.log(`[RAG] Sub-query RRF noise filter fallback: kept top ${kbChunks.length} chunks to prevent empty context`);
      }
    } else {
      // Normal retrieval
      const qaRes = await searchQABank(originalQuery);
      qaChunks = qaRes.qaChunks;
      qaTopScore = qaRes.qaTopScore;

      const kbRes = await searchKBChunks(originalQuery);
      kbChunks = kbRes.kbChunks;
      kbTopScore = kbRes.kbTopScore;
    }

    // MERGE: QA chunks get a small priority boost
    const QA_THRESHOLD = 0.40;
    const validQA = qaChunks.filter(c => c.vectorSim >= QA_THRESHOLD);
    const qaDocFingerprints = new Set(validQA.map(c => c.doc.substring(0, 100).toLowerCase()));
    const dedupedKB = kbChunks.filter(c => !qaDocFingerprints.has(c.doc.substring(0, 100).toLowerCase()));

    const allCandidates = [
      ...validQA.map(c => ({ ...c, priority: 0, rrfScore: (c.rrfScore || 0) + 0.005 })),
      ...dedupedKB.map(c => ({ ...c, priority: 1 }))
    ];
    allCandidates.sort((a, b) => (b.rrfScore || 0) - (a.rrfScore || 0));

    if (!allCandidates.length) {
      return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery], intent };
    }

    // STAGE 3: LLM Rerank
    const rerankLimit = isBroadQuery(originalQuery) ? 6 : 5;
    const { reranked, sufficiencyScore } = await rerankWithLLM(originalQuery, allCandidates, rerankLimit, intent);

    const topScoreRaw = Math.max(qaTopScore, kbTopScore);
    let overallConfidence = getConfidenceLevel(topScoreRaw);

    // ── SOFT ENTITY VERIFICATION & SUFFICIENCY COMBINATIONS ──
    const queryEntities = extractQueryEntities(originalQuery);
    let entityHitRatio = 1.0;
    if (queryEntities.length > 0 && reranked.length > 0) {
      const allChunkText = reranked.map(c => c.doc).join(' ');
      const entityHits = queryEntities.filter(e => indicFuzzyMatch(e, allChunkText));
      entityHitRatio = entityHits.length / queryEntities.length;
    }

    const isLowSufficiency = sufficiencyScore < 0.3;
    const isNoEntityMatch = (queryEntities.length >= 2 && entityHitRatio === 0);

    if (isLowSufficiency && isNoEntityMatch) {
      console.log(`[RAG] DOUBLE FAIL: Low sufficiency (${sufficiencyScore}) AND no entity matches → NONE`);
      overallConfidence = "NONE";
    } else if (isLowSufficiency || isNoEntityMatch) {
      const downgrade = { HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'NONE', NONE: 'NONE' };
      const oldConf = overallConfidence;
      overallConfidence = downgrade[overallConfidence] || overallConfidence;
      console.log(`[RAG] SOFT DOWNGRADE: lowSuff=${isLowSufficiency} noEntity=${isNoEntityMatch} → ${oldConf}→${overallConfidence}`);
    } else if (entityHitRatio < 0.3 && overallConfidence === "HIGH") {
      console.log(`[RAG] WEAK ENTITY: HIGH→MEDIUM`);
      overallConfidence = "MEDIUM";
    }

    console.log(`[RAG] FINAL: ${overallConfidence} (${topScoreRaw.toFixed(3)}) | QA: ${validQA.length}/${qaChunks.length} | KB: ${dedupedKB.length} | Reranked: ${reranked.length}`);

    return {
      chunks: reranked.map(x => ({
        doc: x.doc,
        priority: x.priority,
        source: x.meta?.source || 'Knowledge Base',
        sourceType: x.sourceType,
        confidence: x.confidence,
        similarity: x.similarity
      })),
      sources: reranked.map(x => ({
        type: 'kb',
        title: x.meta?.source || 'Knowledge Base',
        url: x.meta?.source || null,
        preview: x.doc.substring(0, 150)
      })),
      overallConfidence,
      topScore: topScoreRaw.toFixed(3),
      queriesUsed: intent.needs_decomposition && intent.sub_queries && intent.sub_queries.length > 0 ? intent.sub_queries : [originalQuery],
      intent
    };

  } catch (e) {
    console.error('[RAG] Search error:', e.message);
    return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery], intent: null };
  }
}


// --- Save to Supabase ---
async function saveToSupabase(userId, userMessage, aiResponse, source, language, imageUsed) {
  if (!supabase) return;
  try {
    await supabase.from('conversations').insert({
      user_id: userId || 'anonymous',
      user_message: userMessage,
      ai_response: aiResponse,
      source: source || 'unknown',
      language: language || 'en',
      image_used: imageUsed || false
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Supabase save error:`, err.message);
  }
}

// ===========================
// API ROUTES
// ===========================

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Tatva AI',
    version: '1.0.0',
    models: MODELS,
    chromaStatus: chromaReady ? 'connected' : 'disconnected',
    supabaseStatus: supabase ? 'connected' : 'not configured'
  });
});

app.get('/api/test-chunks', async (req, res) => {
  const q = req.query.q || 'is god form or formless'
  const result = await searchDatabase(q)
  const chunks = result.chunks || []
  res.json({
    query: q,
    chunksFound: chunks.length,
    chunks: chunks.map((c, i) => ({
      index: i,
      length: c.doc?.length || 0,
      preview: c.doc?.substring(0, 300) || ''
    }))
  })
})

// --- Test RAG endpoint ---
app.get('/api/test-rag', async (req, res) => {
  const q = req.query.q || 'spiritual wisdom knowledge'
  const result = await searchDatabase(q)
  const chunks = result.chunks || []
  res.json({
    chromaReady,
    query: q,
    chunksFound: chunks.length,
    previews: chunks.map(c => c.doc?.substring(0, 150) || '')
  })
})

function trimToTokenLimit(text, maxChars) {
  if (text.length <= maxChars) return text
  // Cut at last complete sentence within limit
  const trimmed = text.substring(0, maxChars)
  const lastPeriod = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('।'),  // Hindi full stop
    trimmed.lastIndexOf('?'),
    trimmed.lastIndexOf('!')
  )
  return lastPeriod > maxChars * 0.7
    ? trimmed.substring(0, lastPeriod + 1)
    : trimmed
}


// --- Chat ---
app.post('/api/chat', async (req, res) => {
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      console.error('❌ Request Timeout: Chat query handler took >45 seconds');
      res.status(504).json({ error: 'Request Timeout: The query pipeline took too long to respond.' });
    }
  }, 45000);

  res.on('finish', () => clearTimeout(timeoutId));
  res.on('close', () => clearTimeout(timeoutId));

  try {
    const {
      message = '',
      conversationHistory = [],
      imageBase64,
      userId = 'anonymous',
      lat,
      lon,
      latitude: _latitude = null,
      longitude: _longitude = null,
      webSearch = false
    } = req.body;

    // BUG FIX: Frontend sends lat/lon, backend used latitude/longitude — accept both
    const latitude = _latitude ?? lat ?? null;
    const longitude = _longitude ?? lon ?? null;

    // Build coords object if available
    const coords = (latitude && longitude) ? { latitude, longitude } : null;

    if (!message.trim() && !imageBase64) {
      return res.status(400).json({ error: 'Empty message' });
    }
    if (message.length > 6000) {
      return res.status(400).json({ error: 'Message too long' });
    }

    const serverTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full', timeStyle: 'short'
    });

    // ── Load long-term memory ───────────────────────────
    const longTermMemory = loadLongTermMemory(userId);
    const memoryNote = Object.keys(longTermMemory).length > 0
      ? `USER PROFILE (remembered from past conversations): ${JSON.stringify(longTermMemory)}`
      : '';

    // ── Image handling ──────────────────────────────────
    if (imageBase64) {
      const { response, model } = await callGroqWithFallback([{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`
            }
          },
          { type: 'text', text: message || 'Describe this image' }
        ]
      }], true);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      for await (const chunk of response) {
        const text = chunk.choices[0]?.delta?.content;
        if (text && typeof text === 'string') {
          res.write(`data: ${JSON.stringify({
            type: 'token', text
          })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({
        type: 'done', sourceLabel: 'IMAGE', sources: [], suggestions: []
      })}\n\n`);
      res.end();
      return;
    }

    // ── HARD INTERCEPT LOCATION/WEATHER (Strict Intent Isolation) ─────────────────
    let hardInterceptContext = null;
    let syntheticSources = [];
    let toolFailureMessage = null;

    const isWeather = /(weather|temperature|climate)/i.test(message);
    const isLocalSearch = /(near me|nearby|petrol|school|hospital|restaurant)/i.test(message);

    // Module 2 Location API Recovery: If it's a local search but coordinates are missing, fallback instantly
    if (isLocalSearch && !coords) {
      toolFailureMessage = "Please enable location services in your browser to find nearby places.";
    } else if ((isWeather || isLocalSearch) && coords) {
      console.log(`[Interceptor] Match! Intent: ${isWeather ? 'Weather' : 'LocalSearch'}. Fetching deterministic context.`);
      try {
        const areaName = await reverseGeocode(coords.latitude, coords.longitude);

        if (isWeather) {
          const results = await fetchWeather(coords.latitude, coords.longitude);
          if (results.length > 0) {
            hardInterceptContext = `[REAL-TIME WEATHER: Current conditions in ${areaName || 'this area'}: ${results[0].text}. Answer strictly using this data.]`;
            syntheticSources.push({
              type: 'web',
              title: "Current Weather Data",
              domain: "openweathermap.org",
              url: "https://openweathermap.org",
              favicon: "https://openweathermap.org/favicon.ico"
            });
          }
        } else if (isLocalSearch) {
          const cleanQuery = message.replace(/(near me|nearby|around me|mere paas|mere aas paas)/gi, '').trim() || 'places';
          const results = await fetchPlaces(coords.latitude, coords.longitude, cleanQuery);
          if (results.length > 0) {
            hardInterceptContext = `[SYSTEM: The user is looking for nearby places. Here is the live map data:\n${results[0].text}\nYou MUST list these exact places. DO NOT say you lack map access. DO NOT recommend generic apps like Google Maps.]`;
            syntheticSources.push({
              type: 'web',
              title: "Foursquare Places API",
              domain: "foursquare.com",
              url: "https://foursquare.com",
              favicon: "https://foursquare.com/favicon.ico"
            });
          } else {
            toolFailureMessage = "I could not find any locations matching that nearby.";
          }
        }
      } catch (err) {
        console.log('[Interceptor] API failed:', err.message);
      }
    }

    // Module 3: If tool failure (e.g. 0 results), return hardcoded string immediately
    if (toolFailureMessage) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(`data: ${JSON.stringify({ type: 'token', text: toolFailureMessage })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', sourceLabel: 'DIRECT', sources: [], suggestions: [] })}\n\n`);
      res.end();
      return;
    }
    // ── SEARCH QUERY (Invisible Translator removed — expansion handles Hindi variants) ──
    let searchQuery = message;

    // ── CONTEXT-AWARE CLASSIFICATION ────────────────────
    const classification = classifyQuery(message, conversationHistory);
    console.log(`\n[Router] "${message.substring(0, 60)}"`);
    console.log(`[Router] Type: ${classification.type || classification} | Reason: ${classification.reason || ''}`);

    if (classification.type && classification.type.startsWith('CASUAL_')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');

      if (classification.type === 'CASUAL_TIME' || classification.type === 'CASUAL_DATE') {
        const now = new Date();
        const optionsDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' };
        const optionsTime = { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' };
        const dateStr = now.toLocaleDateString('en-IN', optionsDate);
        const timeStr = now.toLocaleTimeString('en-IN', optionsTime);
        const text = classification.type === 'CASUAL_TIME'
          ? `Abhi ${timeStr} hai — ${dateStr}.`
          : `Aaj ki date hai: ${dateStr}.`;
        res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', sourceLabel: null, sources: [], suggestions: [] })}\n\n`);
        res.end();
        return;
      }

      if (classification.type === 'CASUAL_MATH') {
        let text = "Math error.";
        try {
          const result = Function('"use strict";return (' + classification.data + ')')();
          text = `Iska answer hai: ${result}`;
        } catch (e) { }
        res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', sourceLabel: null, sources: [], suggestions: [] })}\n\n`);
        res.end();
        return;
      }

      if (classification.type === 'CASUAL_GREETING') {
        const text = "Namaste! Main Tatva hoon. Kahiye, main aapki kaise madad kar sakta hoon?";
        res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', sourceLabel: null, sources: [], suggestions: [] })}\n\n`);
        res.end();
        return;
      }

      const casualPrompt = classification.type === 'CASUAL_GIBBERISH'
        ? `The user typed something that looks like gibberish or random characters. Respond warmly and briefly: "Hmm, that doesn't quite make sense to me — could you rephrase what you're looking for? 😊"`
        : classification.type === 'CASUAL_SLANG'
          ? `The user said: "${message}". You are Tatva, a friendly AI. Respond naturally, matching their energy. One or two sentences max. No knowledge base. No source label.`
          : `The user reacted with: "${message}". Acknowledge warmly in one sentence and invite their next question.`;

      // Skip KB search, skip web search
      const { response: casualStream } = await callGroqWithFallback([{ role: 'user', content: casualPrompt }], true);
      for await (const chunk of casualStream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text && typeof text === 'string') {
          res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ type: 'done', sourceLabel: null, sources: [], suggestions: [] })}\n\n`);
      res.end();
      return;
    }

    // ── Language detection ──────────────────────────────
    const isHindi = /[\u0900-\u097F]/.test(message) ||
      /\b(kya|hai|hain|mujhe|batao|bolo|karo|aur|aap|tum|yeh|woh|kaise|kyun|kab|kahan|kaun|kitna|matlab|samjho|btao|bata|dekho|suno)\b/i.test(message);

    // ── Sentiment detection ─────────────────────────────
    const isAngry = /\b(useless|bakwaas|bekar|stupid|idiot|worst|terrible|pathetic|faltu|ghatiya|pagal|bewakoof)\b/i.test(message);
    const isSad = /\b(sad|dukhi|udaas|depressed|lonely|akela|anxious|worried|pareshan|darr|dar lag|tense|stressed|hopeless)\b/i.test(message);
    const isExcited = /\b(amazing|wow|great|bahut accha|shandar|zabardast|awesome|fantastic|incredible|excellent|superb)\b/i.test(message);
    const isGrateful = /\b(thank|thanks|shukriya|dhanyawad|dhanyavaad|grateful|appreciate)\b/i.test(message);

    let sentimentNote = '';
    if (isAngry) sentimentNote = 'User seems frustrated. Be patient, calm, and extra helpful.';
    if (isSad) sentimentNote = 'User seems sad or worried. Be warm, empathetic, and supportive.';
    if (isExcited) sentimentNote = 'User is excited! Match their positive energy.';
    if (isGrateful) sentimentNote = 'User is expressing gratitude. Be warm and brief.';

    let dbChunks = [];
    let webResults = [];
    let sources = [];
    let sourceLabel = 'DIRECT';
    let dbOverallConfidence = "NONE";
    let dbTopScore = "0.000";
    let dbQueriesUsed = [];
    let dbIntent = null;

    // ══════════════════════════════════════════════════════
    // IRON WALL ROUTING — strict isolation (Module 3)
    // ══════════════════════════════════════════════════════
    if (isWeather || isLocalSearch) {
      console.log('[Router] Tool Query — STRICT ISOLATION ACTIVE. Skipping RAG/General Web.');
      sources = syntheticSources;
      sourceLabel = isWeather ? 'WEATHER' : 'MAPS';
      // dbChunks and webResults remain empty
    }
    else if (classification.type === 'CASUAL') {
      console.log('[Router] CASUAL — skipping all search');
      sourceLabel = 'DIRECT';
    }
    else if (classification.type === 'WEB_ONLY' || webSearch === true) {
      console.log('[Router] General/Web Intent — Bypassing RAG');
      webResults = await searchWeb(searchQuery, coords);
      sources = webResults.map(r => ({ ...r, type: 'web' }));
      sourceLabel = webResults.length > 0 ? 'WEB' : 'DIRECT';
    }
    else {
      // THEOLOGY / KNOWLEDGE BASE PATH
      console.log('[Router] Theology / KB Query — using RAG');
      const result = await searchDatabase(searchQuery);
      dbChunks = result.chunks;
      sources = result.sources;
      dbOverallConfidence = result.overallConfidence;
      dbTopScore = result.topScore;
      dbQueriesUsed = result.queriesUsed;
      dbIntent = result.intent;
      sourceLabel = dbChunks.length > 0 ? 'DB' : 'DIRECT';

      console.log(`[RAG] Retrieval confidence: ${dbOverallConfidence} (${dbTopScore})`);
      console.log(`[RAG] Queries used: ${dbQueriesUsed.join(" | ")}`);
    }

    // ══════════════════════════════════════════════════════
    // BUILD CONTEXT & SYSTEM PROMPT (TYPE-SPECIFIC)
    // ══════════════════════════════════════════════════════

    // Clean URLs/source tags from KB chunks before injecting into LLM context
    const cleanedChunks = dbChunks.length > 0 ? cleanContext(dbChunks) : [];
    // Structure chunks with [Document X] tags and source type labels
    // so the LLM can clearly distinguish primary vs secondary data
    const SOURCE_TYPE_LABEL = {
      pdf: 'KB Reference - PDF',
      sacred_speech: 'KB Reference - Sacred Speech',
      youtube: 'KB Reference - YouTube Transcript',
      web_page: 'KB Reference - Web Page',
      qa: 'VERIFIED Q&A ANSWER',
      default: 'KB Reference'
    };

    // NotebookLM-style: QA answers go FIRST (highest confidence), then PDF/other chunks
    const qaChunks = cleanedChunks.filter(c => (c.sourceType || '').toLowerCase() === 'qa');
    const kbChunks = cleanedChunks.filter(c => (c.sourceType || '').toLowerCase() !== 'qa');

    let relationNotes = '';
    if (cleanedChunks.length > 0) {
      const allText = cleanedChunks.map(c => c.doc.toLowerCase()).join(' ');
      if (allText.includes('body') || allText.includes('bodies') || allText.includes('layer') || allText.includes('layers') || allText.includes('शरीर') || allText.includes('कोश')) {
        relationNotes += `[SYSTEM NOTE: The following chunks describe the bodies/layers of the soul. Combine all matching bodies/layers (e.g. Physical, Subtle, Causal, etc.) into one complete, synthesized answer detailing all layers mentioned. Do not stop at 3 layers if other chunks list more.]\n`;
      }
      if (allText.includes('expelled') || allText.includes('expulsion') || allText.includes('satlok') || allText.includes('निकाला') || allText.includes('काल')) {
        relationNotes += `[SYSTEM NOTE: The following chunks describe the reasons why Kaal was expelled from Satlok. Synthesize all reasons into a single, cohesive, non-repetitive narrative. Do NOT state the subject repeatedly.]\n`;
      }
    }

    let kbBlock = '';
    if (relationNotes) {
      kbBlock += relationNotes + '\n';
    }

    if (qaChunks.length > 0) {
      kbBlock += `═══ SCRIPTURAL TEACHINGS (Highest Confidence) ═══\n`;
      kbBlock += qaChunks.map((c, i) => {
        return `Excerpt:\n${c.doc}`;
      }).join('\n\n');
    }
    if (kbChunks.length > 0) {
      if (kbBlock) kbBlock += '\n\n';
      kbBlock += `═══ SUPPLEMENTARY TEXTS ═══\n`;
      kbBlock += kbChunks.map((c, i) => {
        return `Excerpt:\n${c.doc}`;
      }).join('\n\n');
    }

    const webBlock = webResults.length > 0
      ? `╔══ WEB SEARCH RESULTS ══╗\n${webResults.map(r =>
        `[${r.title}]${r.url ? '(' + r.url + ')' : ''}: ${r.text}`
      ).join('\n\n')}\n╚══════════════════════╝`
      : '';

    // ── ANSWER DEPTH INTELLIGENCE ─────────────────────────
    let answerInstructions = '';

    if (classification.type === 'CASUAL') {
      // LEVEL 1: MINIMAL
      answerInstructions = `
ANSWER DEPTH: MINIMAL (1-2 sentences)
You are Tatva, a friendly knowledgeable assistant. Respond naturally and warmly to this casual message.
Keep the response to one or two sentences. Match the energy of the user. If they use slang, respond naturally. Never lecture.
No KB context. No source label at the end.`;

    } else if (isWeather || isLocalSearch) {
      // LEVEL 2: TOOL DEPTH — weather/maps
      answerInstructions = `
ANSWER DEPTH: INFORMATIVE & STRUCTURED (Real-Time Context)
▸ Present a highly helpful and professional response based on the "Real-Time Context" (Weather or Places JSON text).
▸ Use rich markdown formatting, bolding key variables (Temps, Areas, Names) and using bullet points for lists of places.
▸ NEVER reveal latitude, longitude, or raw coordinates in your answer.
▸ NEVER say you cannot access location, do not have real-time data, or recommend checking another app.
▸ Do NOT mention "According to JSON or Real-Time Context" - just answer with authority as the ultimate knowing entity.`;

    } else if (classification.type === 'KB_ONLY' || sourceLabel === 'DB') {
      let confidenceInstruction = "";
      if (dbOverallConfidence === "NONE") {
        confidenceInstruction = `
      RETRIEVAL STATUS: NO_RELEVANT_CONTEXT
      No matching chunks were found. Reply exactly with: "The knowledge base does not have sufficient information on this topic."`;
      } else if (dbOverallConfidence === "LOW") {
        confidenceInstruction = `
      RETRIEVAL STATUS: LOW_CONFIDENCE (score: ${dbTopScore})
      The retrieved context is only loosely related. BEFORE answering: check if the key entities from the user's question actually appear in the retrieved chunks. If they do NOT, reply exactly with: "The knowledge base does not have sufficient information on this topic."`;
      } else if (dbOverallConfidence === "MEDIUM") {
        confidenceInstruction = `
      RETRIEVAL STATUS: MEDIUM_CONFIDENCE (score: ${dbTopScore})
      Related context found. CRITICAL: Verify the user's specific question entities appear in chunks before answering. Provide a detailed, natural explanation based on the context.`;
      } else {
        confidenceInstruction = `
      RETRIEVAL STATUS: HIGH_CONFIDENCE (score: ${dbTopScore})
      Relevant context found. STILL: Verify the user's specific question topic is actually covered in the chunks before answering. If the chunks are about a DIFFERENT topic, reply exactly with: "The knowledge base does not have sufficient information on this topic." Answer DIRECTLY from context. Weave source metadata naturally into the explanation.`;
      }

      let intentInstruction = "";
      if (dbIntent) {
        if (dbIntent.question_type === 'how_mechanism' || dbIntent.question_type === 'relational') {
          intentInstruction = `
      QUESTION TYPE: ${dbIntent.question_type.toUpperCase()}
      ▸ Synthesize a step-by-step causal/process explanation strictly from the retrieved chunks.
      ▸ Avoid making assumptions or inventing logical bridges between events — only state connections explicitly written in the chunks.`;
        } else if (dbIntent.question_type === 'factual' || dbIntent.question_type === 'count_or_list') {
          intentInstruction = `
      QUESTION TYPE: ${dbIntent.question_type.toUpperCase()}
      ▸ Keep the answer extremely direct, concise, and focused on the specific fact or list requested.
      ▸ Do not add extra narrative padding.`;
        }
      }

      answerInstructions = `${confidenceInstruction}
      ${intentInstruction}
      
DEPTH: Write a NATURAL, DETAILED, and HUMAN-FRIENDLY answer. Explain concepts deeply if asked. Weave the source metadata naturally into your text (e.g., "As stated in [Source Name]..."). Do NOT add a separate "Pramaan" or "Sources" section at the end.`;

    } else {
      // LEVEL 4: ADAPTIVE FALLBACK — context-grounded only
      answerInstructions = `
ANSWER DEPTH: ADAPTIVE, CONTEXT-GROUNDED
▸ Scan ALL provided context chunks for the answer.
▸ Understand exactly what the user is asking and answer THAT from the context.
▸ Be direct, specific, and informative. No vague statements.
▸ If context does not cover the topic, reply exactly with: "The knowledge base does not have sufficient information on this topic."`;
    }

    const isMultiPerspective =
      /\b(kaise bana|kaise hua|creation|origin|universe|sristi|srishti|duniya kaise|science|scientific|big bang)\b/i.test(message);

    const multiInstruction = isMultiPerspective ? `
MULTIPLE PERSPECTIVES REQUIRED:
1. **Spiritual Perspective:** (Detailed KB context)
2. **Scientific Perspective:** (Mainstream scientific context)
Label each section clearly.` : '';

    // ── CONVERSATION MEMORY & CONTINUITY ─────────────────────
    const recentHistory = conversationHistory.slice(-10);
    const coveredTopics = recentHistory
      .filter(m => m.role === 'assistant')
      .map(m => (m.content || '').slice(0, 120).replace(/\n/g, ' '))
      .join(' | ');
    const ragContext = [kbBlock, webBlock].filter(Boolean).join('\n').trim() || null;

    // ── SYSTEM PROMPT ─────────────────────────
    // Replaces {{CONTEXT_HERE}} placeholder in the base prompt with retrieved context.
    // Note: actual prompt selection (full vs 8B) happens after model selection below.
    const buildSystemPrompt = (useSimple = false) => {
      const basePrompt = useSimple ? SYSTEM_PROMPT_8B : SYSTEM_PROMPT;
      const contextBlock = ragContext || 'No context chunks were retrieved for this query. Reply exactly with: "The knowledge base does not have sufficient information on this topic."';
      let prompt = basePrompt.replace('{{CONTEXT_HERE}}', contextBlock);
      if (answerInstructions) prompt += `\nANSWER DEPTH INSTRUCTION:\n${answerInstructions}`;
      if (multiInstruction) prompt += multiInstruction;
      if (sentimentNote) prompt += `\nUSER TONE NOTE: ${sentimentNote}`;
      if (memoryNote) prompt += `\n${memoryNote}`;
      prompt += `\nCurrent server time: ${serverTime}`;
      return prompt;
    };

    // Default to full prompt; will be swapped if 8B model is used
    const systemPrompt = buildSystemPrompt(false);

    // ── Build messages with sanitized history ──────────
    const sanitizedHistory = sanitizeHistory(conversationHistory, isWeather || isLocalSearch);
    const compressedHistory = compressHistory(sanitizedHistory);

    const allMessages = [
      { role: 'system', content: systemPrompt },
      ...compressedHistory
    ];

    // Module 3 & 1: Inject Deterministic Data and Synthetic Sources
    if (hardInterceptContext) {
      allMessages.push({ role: 'system', content: hardInterceptContext });
    }

    // CONVERSATION CONTINUITY: Allow follow-ups and history references
    allMessages.push({ role: 'system', content: `IMPORTANT: Answer the user's question using the retrieved context chunks. If the user's query is a follow-up or references facts established in the conversation history, you MUST use the established facts from the history alongside the new context to provide a complete, deep answer. Only use the fallback phrase "The knowledge base does not have sufficient information on this topic." as a LAST RESORT if neither context nor history has any relevant facts. Do NOT output this fallback phrase if the answer is logically answerable from the context or the previous turns.` });

    allMessages.push({ role: 'user', content: message });

    // Safety trim
    const totalChars = allMessages.reduce(
      (s, m) => s + (m.content || '').length, 0
    );
    console.log(`[Payload] ${allMessages.length} msgs, ${totalChars} chars`);

    const finalMessages = totalChars > 28000
      ? [allMessages[0], allMessages[1], allMessages[allMessages.length - 1]]
      : allMessages;

    // ── Check semantic cache for previous thumbs-up answers ──
    const cached = getCachedAnswer(message);
    if (cached && sourceLabel === 'DB') {
      // Instead of returning it instantly, we feed it back into the AI to IMPROVE it
      // This satisfies the user's request: "still ai have to improve those answers to that much highest level"
      console.log(`[Cache] Injecting previous liked answer for refinement...`);
      allMessages.push({
        role: 'system',
        content: `[CONTINUOUS IMPROVEMENT PROTOCOL]\nThe user previously "liked" the following answer for this question:\n"${cached.answer}"\n\nYOUR TASK: Use this previous answer as a baseline. DO NOT just copy it. Improve it, refine it, and make it absolutely 100% accurate, informative, and perfectly concise based on the KB chunks. Elevate it to the highest possible quality.`
      });
    }

    const isCached = !!(cached && sourceLabel === 'DB');
    const isHighRisk = (dbIntent?.question_type === 'how_mechanism' || dbIntent?.question_type === 'relational') && dbIntent?.needs_decomposition === true && !isCached;
    let finalAnswerText = '';
    let finalModelUsed = '';
    let isGrounded = true;

    if (isHighRisk && sourceLabel === 'DB') {
      console.log(`[Grounding] High-risk query detected (${dbIntent.question_type}). Performing blocking verification...`);
      try {
        const { response: initialResponse, model: initialModel } = await callGroqWithFallback(finalMessages, false, 0.1, 0.1, false);
        finalModelUsed = initialModel;

        if (initialModel === 'local-fallback') {
          // Streaming fallback if API failed completely
          activeResponse = initialResponse;
        } else {
          let answerText = initialResponse.choices[0]?.message?.content || '';
          console.log(`[Grounding] Blocking check: validating generated answer (${answerText.length} chars)...`);
          const groundingResult = await checkAnswerGrounding(answerText, dbChunks, message);
          
          if (!groundingResult.grounded) {
            console.log(`[Grounding] UNGROUNDED claims found:`, groundingResult.ungrounded_claims);
            isGrounded = false;

            // Strip the ungrounded claims from the original draft answer
            console.log(`[Grounding] Stripping ungrounded claims from the draft response...`);
            const stripPrompt = `You are a precise fact-editor. Edit the following DRAFT ANSWER to remove ONLY these specific ungrounded claims or connections:
${groundingResult.ungrounded_claims.map(c => `- ${c}`).join('\n')}

DRAFT ANSWER:
"${answerText}"

Rules:
1. Strip ONLY the sentences or clauses that assert or imply those ungrounded claims.
2. Keep all other sentences and facts exactly as they are.
3. Ensure the remaining text flows naturally, is grammatically correct, and maintains formatting.
4. Do NOT add any new facts or claims.
5. If removing the claims leaves the answer empty or completely ungrounded, reply exactly with: "The knowledge base does not have sufficient information on this topic."

Edited Answer:`;

            const { response: retryResponse, model: retryModel } = await callGroqWithFallback([
              { role: 'user', content: stripPrompt }
            ], false, 0.0, 0.0, false);
            finalModelUsed = retryModel;
            answerText = retryResponse.choices[0]?.message?.content || '';

            // Run a quick second grounding check
            const secondGroundingResult = await checkAnswerGrounding(answerText, dbChunks, message);
            if (!secondGroundingResult.grounded) {
              console.log(`[Grounding] Second check failed. Appending warning disclaimer.`);
              answerText += '\n\n⚠️ *Some details in this answer may not be directly from the knowledge base.*';
            } else {
              isGrounded = true;
            }
          }
          finalAnswerText = answerText;
        }
      } catch (err) {
        console.warn(`[Grounding] Blocking check error: ${err.message}. Falling back to normal stream.`);
        isHighRisk = false; // Fall back to streaming
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    let fullText = '';
    let modelUsed = finalModelUsed;

    if (finalAnswerText) {
      res.setHeader('X-Active-Model', finalModelUsed);
      // Simulate streaming to client for the pre-computed response
      const chunkSize = 12;
      for (let i = 0; i < finalAnswerText.length; i += chunkSize) {
        if (res.writableEnded || res.finished) break;
        const chunkStr = finalAnswerText.substring(i, i + chunkSize);
        fullText += chunkStr;
        res.write(`data: ${JSON.stringify({ type: 'token', text: chunkStr })}\n\n`);
        await new Promise(r => setTimeout(r, 8)); // smooth streaming simulation
      }
    } else {
      // Normal streaming path
      const { response: normalResponse, model: normalModel, is8B } = await callGroqWithFallback(finalMessages, false, 0.1, 0.1, true);
      modelUsed = normalModel;
      res.setHeader('X-Active-Model', normalModel);

      for await (const chunk of normalResponse) {
        if (res.writableEnded || res.finished) break;
        const text = chunk.choices[0]?.delta?.content;
        if (!text || typeof text !== 'string') continue;
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
      }

      // Post-hoc grounding check for normal path
      if (!isCached && sourceLabel === 'DB' && fullText.length > 100) {
        try {
          const groundingResult = await checkAnswerGrounding(fullText, dbChunks, message);
          if (!groundingResult.grounded) {
            console.log(`[Grounding] UNGROUNDED claims found post-hoc:`, groundingResult.ungrounded_claims);
            isGrounded = false;
            const disclaimer = '\n\n⚠️ *Some details in this answer may not be directly from the knowledge base.*';
            res.write(`data: ${JSON.stringify({ type: 'token', text: disclaimer })}\n\n`);
            fullText += disclaimer;
          }
        } catch (err) {
          console.warn(`[Grounding] Post-hoc grounding check failed:`, err.message);
        }
      }
    }

    // Store in semantic cache for future identical questions ONLY if grounded
    if (sourceLabel === 'DB' && fullText.length > 50 && isGrounded) {
      setCachedAnswer(message, fullText, sources);
    }

    // ── Generate AI-powered follow-up suggestions ───────
    let suggestions = [];
    if (sourceLabel !== 'DIRECT') {
      try {
        suggestions = await generateAISuggestions(message, fullText);
      } catch (err) {
        console.warn('[Suggestions] Failed:', err.message);
        suggestions = [];
      }
    }

    // Module 3: Build final sources for frontend panel including synthetic attributions
    const allSources = [
      ...(syntheticSources || []),
      ...sources
    ];

    res.write(`data: ${JSON.stringify({
      type: 'done',
      sourceLabel,
      sources: allSources,
      suggestions,
      model: modelUsed || 'unknown',
      chunksUsed: dbChunks.length,
      webResultsUsed: webResults.length
    })}\n\n`);
    res.end();

    // ── Save to session memory ──────────────────────────
    try {
      if (sessionMemory) {
        if (!sessionMemory.has(userId)) {
          sessionMemory.set(userId, []);
        }
        const hist = sessionMemory.get(userId);
        hist.push({ role: 'user', content: message });
        hist.push({ role: 'assistant', content: fullText });
        if (hist.length > 20) hist.splice(0, hist.length - 20);
      }
    } catch (e) { }

    // ── Extract and save long-term memory facts ─────────
    try {
      const userFacts = extractMemoryFacts(message);
      if (Object.keys(userFacts).length > 0) {
        saveLongTermMemory(userId, userFacts);
      }
    } catch (e) {
      console.warn('[Memory] Extraction failed:', e.message);
    }

  } catch (e) {
    console.error('[Chat] Fatal error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: e.message === 'ALL_MODELS_FAILED'
          ? 'All AI models busy. Try again in 30 seconds.'
          : 'Something went wrong. Please try again.'
      });
    }
  }
})

// --- Memory Endpoints ---
app.post('/api/memory/save', (req, res) => {
  const { userId, message, response, sourceLabel } = req.body
  if (!userId) return res.status(400).json({ error: 'No userId' })

  if (!sessionMemory.has(userId)) {
    sessionMemory.set(userId, [])
  }
  const history = sessionMemory.get(userId)
  history.push({ role: 'user', content: message })
  history.push({ role: 'assistant', content: response })

  // Keep last 20 messages (10 exchanges)
  if (history.length > 20) history.splice(0, history.length - 20)
  sessionMemory.set(userId, history)

  res.json({ saved: true, totalMessages: history.length })
})

app.get('/api/memory/:userId', (req, res) => {
  const history = sessionMemory.get(req.params.userId) || []
  res.json({ history })
})

app.delete('/api/memory/:userId', (req, res) => {
  sessionMemory.delete(req.params.userId)
  res.json({ cleared: true })
})

// --- Feedback Endpoint ---
app.post('/api/feedback', (req, res) => {
  const { query, answer, feedback } = req.body;
  if (!query || feedback === undefined) return res.status(400).json({ error: 'Missing data' });

  const key = normalizeQuery(query);

  if (feedback === -1) {
    // User downvoted: Delete from semantic cache so it answers differently next time
    if (semanticCache.has(key)) {
      semanticCache.delete(key);
      console.log(`[Feedback] Thumbs DOWN for "${query.substring(0, 30)}..." - Removed from cache.`);
    }
  } else if (feedback === 1) {
    // User upvoted: Ensure it's in cache and extend TTL to effectively 'remember' it
    console.log(`[Feedback] Thumbs UP for "${query.substring(0, 30)}..." - Answer remembered!`);
    if (semanticCache.has(key)) {
      const cached = semanticCache.get(key);
      cached.timestamp = Date.now() + 1000 * 60 * 60 * 24 * 365; // 1 year TTL
    }
  }

  // Log to a file
  const fs = require('fs');
  const path = require('path');
  const feedbackFile = path.join(__dirname, 'scratch', 'user_feedback.jsonl');
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    query,
    answer,
    feedback
  }) + '\n';

  fs.appendFile(feedbackFile, entry, (err) => {
    if (err) console.error('[Feedback] Failed to write feedback:', err.message);
  });

  res.json({ success: true, feedbackReceived: feedback });
});

// --- PDF Upload ---
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided.' });
    }

    const filePath = req.file.path;
    let text = '';
    try {
      const pythonScript = `
import fitz, sys, json
doc = fitz.open(sys.argv[1])
pages = []
for page in doc:
    t = page.get_text()
    if len(t.strip()) > 50:
        pages.append(t)
print(json.dumps(pages))
`;
      const tmpScript = path.join(__dirname, '_extract_pdf.py');
      fs.writeFileSync(tmpScript, pythonScript);
      const output = execSync(`python3 "${tmpScript}" "${filePath}"`, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
      const pages = JSON.parse(output.toString());
      text = pages.join('\n\n');
      fs.unlinkSync(tmpScript);
    } catch (pyErr) {
      console.error(`[${new Date().toISOString()}] PDF extraction error:`, pyErr.message);
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'Failed to extract text from PDF. Make sure pymupdf is installed: pip3 install pymupdf' });
    }

    if (!text.trim()) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'PDF appears to be empty or contains only images.' });
    }

    const chunkSize = 4000;    // Increased to 4000 chars (approx 1000 tokens)
    const overlap = 600;       // Increased to 600 for 15% overlap
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      const chunk = text.slice(i, i + chunkSize).trim();
      if (chunk.length > 30) chunks.push(chunk);
    }

    if (chromaAvailable && chromaCollection) {
      try {
        const ids = chunks.map((_, idx) => `${req.file.originalname}_chunk_${idx}`);
        const metadatas = chunks.map(() => ({ source: req.file.originalname }));
        await chromaCollection.add({ ids, documents: chunks, metadatas });
      } catch (dbErr) {
        console.error(`[${new Date().toISOString()}] ChromaDB add error:`, dbErr.message);
      }
    }

    fs.unlinkSync(filePath);
    res.json({ success: true, chunksAdded: chunks.length, filename: req.file.originalname });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Upload error:`, err.message);
    res.status(500).json({ error: 'PDF processing failed.' });
  }
});

// --- TTS ---
app.post('/api/tts', (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required.' });

    let cleanText = text
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`[^`]*`/g, '')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[|>_~-]{2,}/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();

    if (cleanText.length > 500) {
      cleanText = cleanText.substring(0, 497) + '...';
    }

    const hindiRegex = /[\u0900-\u097F]/;
    const detectedLang = hindiRegex.test(cleanText) ? 'hi-IN' : 'en-US';

    res.json({ cleanText, language: language || detectedLang });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] TTS error:`, err.message);
    res.status(500).json({ error: 'TTS processing failed.' });
  }
});

// --- History ---
app.get('/api/history/:userId', async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ conversations: [] })
    }
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      console.warn('[History] Supabase error:', error.message)
      return res.json({ conversations: [] })
    }
    res.json({ conversations: data || [] })
  } catch (e) {
    console.warn('[History] Failed silently:', e.message)
    res.json({ conversations: [] })
  }
})

app.post('/api/history', async (req, res) => {
  try {
    if (!supabase) return res.json({ saved: false })
    const { userId, message, response, source } = req.body
    const { error } = await supabase
      .from('conversations')
      .insert({
        user_id: userId,
        user_message: message,
        ai_response: response,
        source: source
      })
    if (error) {
      console.warn('[History] Save error:', error.message)
      return res.json({ saved: false })
    }
    res.json({ saved: true })
  } catch (e) {
    console.warn('[History] Save failed silently:', e.message)
    res.json({ saved: false })
  }
})

app.delete('/api/history/:conversationId', async (req, res) => {
  try {
    if (!supabase) return res.json({ success: false, reason: 'Supabase not configured' });
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', req.params.conversationId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] History delete error:`, err.message);
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

let embedServiceProcess = null;

function startEmbeddingService() {
  const { spawn } = require('child_process');
  const path = require('path');
  const scriptPath = path.join(__dirname, 'embed_service.py');

  console.log('🔷 Starting persistent embedding service on port 5002...');
  embedServiceProcess = spawn('python3', [scriptPath, '5002'], {
    detached: false,
    stdio: 'ignore'
  });

  embedServiceProcess.on('error', (err) => {
    console.error('❌ Failed to start persistent embedding service:', err.message);
  });

  const cleanup = () => {
    if (embedServiceProcess) {
      console.log('🔷 Stopping persistent embedding service...');
      embedServiceProcess.kill('SIGINT');
      embedServiceProcess = null;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// --- Start Server ---
app.listen(PORT, () => {
  startEmbeddingService();

  console.log('');
  console.log('  त  Tatva AI Backend');
  console.log(`  → Running on http://localhost:${PORT}`);
  console.log(`  → ChromaDB: ${chromaReady ? 'connected' : 'disconnected'}`);
  console.log(`  → Supabase: ${supabase ? 'connected' : 'not configured'}`);
  console.log('');
});
