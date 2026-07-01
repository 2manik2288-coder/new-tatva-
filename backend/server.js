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

// In-memory session store (use Redis for production)
const sessionMemory = new Map();

// --- SYSTEM PROMPT ---
const SYSTEM_PROMPT = `You are Tatva, a spiritual knowledge assistant. You have been given a CONTEXT block below that contains retrieved excerpts from your knowledge base of sacred scriptures and verified teachings.
THE ONLY LAW: You may ONLY use information that is explicitly present in the CONTEXT block below. Nothing else.

ABSOLUTE RESTRICTIONS — violating any of these is a failure:

1. NO outside knowledge. You have no memory, no training knowledge, no internet. If it is not in the CONTEXT, it does not exist for you.
2. NO hallucination. Do not generate any verse, quote, page number, chapter, or fact that is not word-for-word present in the CONTEXT. If you are not sure, do not say it.
3. Synthesis Mandate: You MUST synthesize information across ALL provided context chunks. If one chunk mentions 3 items and another chunk mentions 2 more items on the same topic, your answer must include ALL 5 items. Never answer from a single chunk when multiple chunks contain pieces of the same answer.
4. Answer Depth: Provide comprehensive, detailed answers. Do not give minimal or surface-level responses. When multiple chunks contain related details, weave them into a thorough explanation. Include specific names, numbers, mechanisms, and consequences mentioned in the text. The user expects depth comparable to a detailed theological exposition, not a brief summary.
5. Non-Repetitive Synthesis: When multiple chunks mention different reasons or aspects of the same event, merge them into a single, non-repetitive narrative. Do NOT restate the subject multiple times (e.g., do not repeat "Kaal was expelled because..."). Use smooth transitions like "Furthermore," "Additionally," or "Moreover," keeping the subject stated only once.
6. NO metadata in answers. Never mention "Verified Q&A Bank", document names, file names, website URLs, chunk numbers, or database IDs — these are internal only, invisible to the user.
7. If the CONTEXT does not contain enough information to answer the question, reply exactly with: "The knowledge base does not have sufficient information on this topic." — Do not guess, do not fill gaps with general knowledge.
8. Your answers must be built ONLY from the retrieved context chunks provided below. Do not use your general training knowledge about Hinduism, Vedas, or spirituality to fill gaps or make answers sound more complete.
9. If the retrieved context does not contain enough information to answer a specific part of the question, say exactly that: 'The texts I have access to do not specifically address this aspect.' Do not invent a plausible answer.
10. Sant Rampal Ji Maharaj's explanations are the highest authority in this knowledge base. When referencing scriptures like Vedas or Gita, prefer His explanation of those verses over any other interpretation. When you have chunks from both Sant Rampal Ji's explanations and original scriptures, build your answer primarily from Sant Rampal Ji's explanation and use original scripture as supporting pramaan (proof). Never contradict what Sant Rampal Ji says using original scripture alone.
11. Never output internal system labels like 'Q&A Bank', 'tier-1', 'tier-2', 'chunk', 'Sources', citation numbers, source_tier, or any metadata identifiers. Speak as Tatva, a knowledgeable spiritual guide.

HOW TO ANSWER:

- Read the question carefully.
- Find only the parts of CONTEXT that directly answer it.
- Write a clean, factual answer using only those parts.
- Cite only real scripture references that appear in the CONTEXT (book name, chapter, verse, page — only if present).
- Match the user's language: Hindi, English, or Hinglish — auto-detect, never ask.
- Length: as deep and comprehensive as the retrieved facts support.

RETRIEVED CONTEXT:
{{CONTEXT_HERE}}`;

// When falling back to the small 8B model, use this simpler prompt it can actually follow
const SYSTEM_PROMPT_8B = `You are Tatva, a deeply knowledgeable spiritual AI assistant.
Answer questions with depth, accuracy, and reverence based on authentic scriptures.

RULES:
1. NEVER mention "Verified Q&A Bank", document IDs, URLs, or "according to context".
2. Cite real scriptures (book, chapter, verse, page) naturally in your response.
3. Stay on topic. Do not add tangents or promotional language.
4. Provide thorough, scripture-based answers.
5. Sound like a scholar, write naturally. Do NOT sound like a search engine.
6. Ignore garbage metadata.
7. Match the user's language (Hindi, English, Hinglish).

RETRIEVED CONTEXT:
{{CONTEXT_HERE}}`;


// --- SEMANTIC CACHE ---
// Caches answers for similar questions to avoid redundant API calls (kills 429 rate limits)
const semanticCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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
  if (cached) semanticCache.delete(key); // expired
  return null;
}

function setCachedAnswer(query, answer, sources) {
  const key = normalizeQuery(query);
  semanticCache.set(key, { answer, sources, timestamp: Date.now() });
  // Cap cache size at 200 entries
  if (semanticCache.size > 200) {
    const oldestKey = semanticCache.keys().next().value;
    semanticCache.delete(oldestKey);
  }
  console.log(`[Cache] STORED for: "${query.substring(0, 50)}..." (${semanticCache.size} cached)`);
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

    // Load dedicated QA collection
    if (collectionNames.includes(QA_COLLECTION_NAME)) {
      chromaQACollection = await client.getCollection({ name: QA_COLLECTION_NAME, embeddingFunction: customEmbedder })
      const qaCount = await chromaQACollection.count()
      console.log(`[Chroma] "${QA_COLLECTION_NAME}" has ${qaCount} verified Q&A pairs`)
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
  'llama-3.1-8b-instant'
];

async function callGroqWithFallback(messages, isVision = false, temperature = 0.1, top_p = 0.1) {
  const visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct'

  if (isVision) {
    const groq = new Groq({ apiKey: apiKeys[0] || 'dummy' });
    const response = await groq.chat.completions.create({
      model: visionModel,
      messages,
      stream: true,
      max_tokens: 1024
    })
    return { response, model: visionModel }
  }

  let lastError;
  let retryCount = 0;
  const maxRetries = 5;

  while (retryCount <= maxRetries) {
    for (const model of MODELS) {
      for (let i = 0; i < apiKeys.length; i++) {
        try {
          const groq = new Groq({ apiKey: apiKeys[i] });
          const response = await groq.chat.completions.create({
            model,
            messages,
            stream: true,
            temperature: 0.1,
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
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          if (status === 413) {
            console.log(`[Groq] Payload too large for ${model}. Downgrading model...`);
            if (messages[0]?.role === 'system') {
              const sysLen = messages[0].content.length;
              if (sysLen > 8000) {
                messages[0].content = messages[0].content.substring(0, 8000) + '\\n[Context trimmed]';
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
      const delay = Math.pow(2, retryCount) * 1500; // 3s, 6s, 12s
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
        const words = clean.split(/\\s+/);
        const hasRealWord = words.some(w => w.length > 3 && /[aeiouy]/i.test(w));
        if (!hasRealWord) return true;
      }
      if (/^[^aeiou\\s]{3,}$/i.test(clean.replace(/[^a-z]/g, ''))) return true;
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
    const wordsCount = query.split(/\\s+/).length;
    const hasPronoun = /\\b(it|this|that|they|him|her|those)\\b/i.test(queryLower);
    const startsWithFollowupWord = /^(and|but|also|what about|tell me more|explain|why|how|elaborate|go deeper|give me more|what else)\\b/i.test(queryLower);

    if ((wordsCount < 20 && hasPronoun) || startsWithFollowupWord) {
      let fallbackTarget = 'KB_FIRST';
      if (conversationHistory.length > 0) {
        const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMsg) {
          const prevContent = lastAssistantMsg.content.toLowerCase();
          if (/\\b(restaurant|weather|score|price|news|recipe|python|javascript|react)\\b/i.test(prevContent)) {
            fallbackTarget = 'WEB_ONLY';
          } else {
            fallbackTarget = 'KB_ONLY';
          }
        }
      }
      return { type: fallbackTarget, isFollowUp: true, reason: 'Follow-up query detected' };
    }

    // ── TIER 3 — LOCATION SEARCH ──
    if (/\\b(near me|nearby|in my area|around me|close to me|mere paas|aas paas|local|closest)\\b/i.test(queryLower)) {
      return { type: 'WEB_ONLY', isLocationSearch: true, reason: 'Location search detected' };
    }

    // ── TIER 2 — WEB SEARCH QUERIES ──
    const webTerms = [
      'latest', 'recently', 'now', 'current', 'today', 'news', '2024', '2025', '2026',
      'price', 'score', 'match', 'update', 'trending', 'who won', 'what happened',
      'new release', 'just launched', 'stock', 'weather', '\\bvs\\b'
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
    if (kbTerms.some(term => new RegExp('\\\\b' + term + '\\\\b', 'i').test(queryLower))) {
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
    'pipa': 'pipa', 'pepa': 'pipa',
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

// ═══════════════════════════════════════════════════════
// COSINE SIMILARITY HELPER (ChromaDB cosine distance → similarity)
// ChromaDB cosine distance = 1 - cos_sim, ranges 0 (identical) to 2 (opposite)
// ═══════════════════════════════════════════════════════
function cosineDistToSim(distance) {
  if (distance == null || distance >= 999) return 0;
  // ChromaDB cosine distance: 0 = identical, 2 = opposite
  return Math.max(0, 1 - (distance / 2));
}

// ═══════════════════════════════════════════════════════
// KEYWORD OVERLAP SCORE — hybrid signal alongside vector similarity
// Gives a boost when the user's key terms appear verbatim in the chunk
// ═══════════════════════════════════════════════════════
function keywordOverlapScore(query, docText) {
  const stopWords = new Set(['what','who','how','why','when','where','which','is','are','was','were','did','does','do','can','tell','me','about','the','a','an','of','in','from','for','to','and','or','by','with','this','that','it','those','these','many','much','full','story','detail','kahani','kya','kaun','kaise','kyun','kab','kahan','batao','bolo','ki','ke','ka','mein','hai','hain','se','ko','ne','par','jo','ye','wo','vo','ek','aur','ya','thi','tha','sab','koi','bahut','konsa','konse','kaunsa']);
  const queryWords = query.toLowerCase().replace(/[?.,!"']/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  if (queryWords.length === 0) return 0;
  const docLower = docText.toLowerCase();
  const hits = queryWords.filter(w => docLower.includes(w)).length;
  return hits / queryWords.length; // 0.0 to 1.0
}

function isBroadQuery(query) {
  return /^(how many|what is|explain|describe|what are|who is|tell me about|list|kya hai|kaise|kitne|kaun|body layers|souls layers)/i.test(query.trim());
}

// ═══════════════════════════════════════════════════════
// STAGE 1: QA PRECISION LOOKUP (dedicated collection)
// ═══════════════════════════════════════════════════════
async function searchQABank(originalQuery) {
  if (!chromaQACollection) return { qaChunks: [], qaTopScore: 0 };

  try {
    const queries = expandQueryLocal(originalQuery);
    console.log(`[QA] Searching with ${queries.length} variants:`, queries);

    const nResults = isBroadQuery(originalQuery) ? 15 : 10;
    const results = await chromaQACollection.query({
      queryTexts: queries,
      nResults: nResults,
      include: ['documents', 'distances', 'metadatas']
    });

    // Deduplicate by QA number, keep best score per QA
    const qaBestScores = new Map(); // qaNum -> best chunk object

    queries.forEach((q, queryIdx) => {
      const docs = results.documents?.[queryIdx] || [];
      const distances = results.distances?.[queryIdx] || [];
      const metadatas = results.metadatas?.[queryIdx] || [];

      docs.forEach((doc, i) => {
        const qaNum = metadatas[i]?.qa_num || metadatas[i]?.source || doc.substring(0, 50);
        const vectorSim = cosineDistToSim(distances[i]);
        // Hybrid score: 70% vector similarity + 30% keyword overlap
        const kwScore = keywordOverlapScore(originalQuery, doc);
        const hybridSim = (vectorSim * 0.7) + (kwScore * 0.3);

        const existing = qaBestScores.get(qaNum);
        if (!existing || hybridSim > existing.similarity) {
          qaBestScores.set(qaNum, {
            doc,
            similarity: hybridSim,
            vectorSim,
            kwScore,
            confidence: getConfidenceLevel(hybridSim),
            meta: metadatas[i] ?? {},
            sourceType: 'qa'
          });
        }
      });
    });

    const allQA = Array.from(qaBestScores.values());
    allQA.sort((a, b) => b.similarity - a.similarity);
    const qaLimit = isBroadQuery(originalQuery) ? 12 : 8;
    const topQA = allQA.slice(0, qaLimit);

    const qaTopScore = topQA[0]?.similarity || 0;
    topQA.slice(0, 5).forEach((c, i) => {
      console.log(`[QA] #${i+1} | Hybrid: ${c.similarity.toFixed(3)} (vec: ${c.vectorSim.toFixed(3)}, kw: ${c.kwScore.toFixed(2)}) | Q: ${(c.meta?.question || c.doc).substring(0, 80)}...`);
    });
    console.log(`[QA] Found ${topQA.length} Q&A candidates (top hybrid: ${qaTopScore.toFixed(3)})`);

    return { qaChunks: topQA, qaTopScore };
  } catch (e) {
    console.error('[QA] Search error:', e.message);
    return { qaChunks: [], qaTopScore: 0 };
  }
}

// ═══════════════════════════════════════════════════════
// STAGE 2: KB VECTOR SEARCH (main collection)
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

    // Tight deduplication (0.5 word overlap = duplicate)
    let allFiltered = [];
    let seenDocs = new Set();

    queries.forEach((q, queryIdx) => {
      const docs = results.documents?.[queryIdx] || [];
      const distances = results.distances?.[queryIdx] || [];
      const metadatas = results.metadatas?.[queryIdx] || [];

      docs.forEach((doc, i) => {
        if (doc.length < 40) return;
        // Allow QA-type chunks as fallback (Stage 1 handles dedicated QA collection,
        // but if QA collection is down, we still want QA data from main KB)
        const srcType = metadatas[i]?.type || '';

        const docWords = new Set(doc.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let isDuplicate = false;
        for (const seen of seenDocs) {
          const seenWords = new Set(seen.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const overlap = [...docWords].filter(w => seenWords.has(w)).length;
          const similarity = overlap / Math.max(docWords.size, 1);
          if (similarity > 0.50) { isDuplicate = true; break; }
        }
        if (!isDuplicate) {
          seenDocs.add(doc);
          const vectorSim = cosineDistToSim(distances[i]);
          const kwScore = keywordOverlapScore(originalQuery, doc);
          // Tier-based re-ranking: tier-1 (Sant Rampal Ji) gets 1.3x boost
          const sourceTier = metadatas[i]?.source_tier || 2;
          const tierBoost = sourceTier === 1 ? 1.3 : 1.0;
          const hybridSim = ((vectorSim * 0.7) + (kwScore * 0.3)) * tierBoost;
          allFiltered.push({
            doc,
            similarity: hybridSim,
            vectorSim,
            kwScore,
            sourceTier,
            confidence: getConfidenceLevel(hybridSim),
            meta: metadatas[i] ?? {},
            sourceType: srcType || 'pdf'
          });
        }
      });
    });

    // Entity-boosted reranking: chunks containing user's key entities rank higher
    const corrections = {
      'guns': 'gunas', 'gun': 'guna', 'mahakala': 'mahakal', 'mahakalas': 'mahakal',
      'moksh': 'moksha', 'moks': 'moksha', 'satlog': 'satlok', 'sachkand': 'sachkhand',
      'kabeer': 'kabir', 'kabirr': 'kabir', 'kundlini': 'kundalini', 'kundalani': 'kundalini',
      'bhagwat': 'bhagavad', 'geeta': 'gita', 'shiv': 'shiva', 'vishu': 'vishnu', 'vishno': 'vishnu',
      'bramha': 'brahma', 'bramh': 'brahm', 'triydev': 'tridev', 'trimurti': 'trinity',
      'sakti': 'shakti', 'shakthi': 'shakti', 'sev': 'seu', 'saman': 'samman',
      'garibdas': 'garibdas', 'gareebdas': 'garibdas', 'ramanand': 'ramanand', 'ramanad': 'ramanand',
      'dharamdas': 'dharamdas', 'dharmdas': 'dharamdas', 'prahlad': 'prahlad', 'prahalad': 'prahlad',
      'naamdev': 'namdev', 'namdeo': 'namdev', 'ravidas': 'ravidas', 'ravidaas': 'ravidas',
      'dadu': 'dadu', 'dadoo': 'dadu', 'pipa': 'pipa', 'pepa': 'pipa', 'ajamil': 'ajamil', 'ajaamal': 'ajamil'
    };
    let correctedKbQuery = originalQuery.toLowerCase().trim();
    for (const [wrong, right] of Object.entries(corrections)) {
      if (correctedKbQuery.includes(wrong)) {
        correctedKbQuery = correctedKbQuery.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
      }
    }

    const kbStopWords = new Set(['what','who','how','why','when','where','which','is','are','was','were','did','does','do','can','tell','me','about','the','a','an','of','in','from','for','to','and','or','by','with','this','that','it','those','these','many','much','full','story','detail','kahani','kya','kaun','kaise','kyun','kab','kahan','batao','bolo','ki','ke','ka','mein','hai','hain','se','ko','ne','par','jo','ye','wo','vo','ek','aur','ya','thi','tha','sab','koi','bahut','konsa','konse','kaunsa']);
    const kbQueryEntities = correctedKbQuery.replace(/[?.,!]/g, '').split(/\s+/).filter(w => w.length > 2 && !kbStopWords.has(w));

    if (kbQueryEntities.length > 0) {
      allFiltered.forEach(c => {
        const docLower = c.doc.toLowerCase();
        // Boost if chunk contains the entity (using word boundary)
        const hits = kbQueryEntities.filter(e => new RegExp(`\\b${e}\\b`, 'i').test(docLower)).length;
        const boost = (hits / kbQueryEntities.length) * 0.12; // Up to 12% boost
        c.boostedSim = c.similarity + boost;
      });
      allFiltered.sort((a, b) => (b.boostedSim || b.similarity) - (a.boostedSim || a.similarity));
    } else {
      allFiltered.sort((a, b) => b.similarity - a.similarity);
    }
    const kbLimit = isBroadQuery(originalQuery) ? 15 : 10;
    const topKB = allFiltered.slice(0, kbLimit);

    const kbTopScore = topKB[0]?.similarity || 0;
    topKB.slice(0, 3).forEach((c, i) => {
      console.log(`[KB] #${i+1} | Hybrid: ${c.similarity.toFixed(3)} (vec: ${c.vectorSim?.toFixed(3)}, kw: ${c.kwScore?.toFixed(2)}) | Src: ${(c.meta?.source || 'KB').substring(0, 50)} | "${c.doc.substring(0, 80)}..."`);
    });
    console.log(`[KB] Found ${topKB.length} KB chunks (top hybrid: ${kbTopScore.toFixed(3)})`);

    return { kbChunks: topKB, kbTopScore };
  } catch (e) {
    console.error('[KB] Search error:', e.message);
    return { kbChunks: [], kbTopScore: 0 };
  }
}

// ═══════════════════════════════════════════════════════
// MASTER RETRIEVAL: QA FIRST → KB SECOND
// ═══════════════════════════════════════════════════════
async function searchDatabase(originalQuery) {
  if (!chromaReady || !chromaCollection) {
    console.log('[RAG] ChromaDB not ready');
    return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery] };
  }

  try {
    // STAGE 1: Precision QA lookup
    const { qaChunks, qaTopScore } = await searchQABank(originalQuery);

    // STAGE 2: General KB search
    const { kbChunks, kbTopScore } = await searchKBChunks(originalQuery);

    // MERGE: QA chunks above threshold get priority boost; KB chunks fill in context
    // Threshold lowered from 0.68 → 0.40 because correct cosine formula now gives proper scores
    const QA_THRESHOLD = 0.40;
    const validQA = qaChunks.filter(c => c.similarity >= QA_THRESHOLD);
    
    // Deduplicate: if a QA chunk is also in KB results, prefer the QA version
    const qaDocFingerprints = new Set(validQA.map(c => c.doc.substring(0, 100).toLowerCase()));
    const dedupedKB = kbChunks.filter(c => !qaDocFingerprints.has(c.doc.substring(0, 100).toLowerCase()));

    const allChunks = [
      // QA chunks get +0.10 boost to always rank above loosely matched KB chunks
      ...validQA.map(c => ({ ...c, priority: 0, effectiveScore: (c.boostedSim || c.similarity) + 0.10 })),
      ...dedupedKB.map(c => ({ ...c, priority: 1, effectiveScore: c.boostedSim || c.similarity }))
    ];

    // Sort by effective score so highly relevant KB chunks can outrank irrelevant QA chunks
    allChunks.sort((a, b) => b.effectiveScore - a.effectiveScore);

    const limit = isBroadQuery(originalQuery) ? 10 : 6;
    const finalChunks = allChunks.slice(0, limit);

    if (!finalChunks.length) {
      return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery] };
    }

    const topScoreRaw = Math.max(validQA[0]?.similarity || 0, dedupedKB[0]?.similarity || 0);
    let overallConfidence = getConfidenceLevel(topScoreRaw);

    // ── ENTITY VERIFICATION (relaxed for Hindi/Hinglish) ──
    // Only downgrade if ZERO key entities match, not just <30%
    const corrections = {
      'guns': 'gunas', 'gun': 'guna', 'mahakala': 'mahakal', 'mahakalas': 'mahakal',
      'moksh': 'moksha', 'moks': 'moksha', 'satlog': 'satlok', 'sachkand': 'sachkhand',
      'kabeer': 'kabir', 'kabirr': 'kabir', 'kundlini': 'kundalini', 'kundalani': 'kundalini',
      'bhagwat': 'bhagavad', 'geeta': 'gita', 'shiv': 'shiva', 'vishu': 'vishnu', 'vishno': 'vishnu',
      'bramha': 'brahma', 'bramh': 'brahm', 'triydev': 'tridev', 'trimurti': 'trinity',
      'sakti': 'shakti', 'shakthi': 'shakti', 'sev': 'seu', 'saman': 'samman',
      'garibdas': 'garibdas', 'gareebdas': 'garibdas', 'ramanand': 'ramanand', 'ramanad': 'ramanand',
      'dharamdas': 'dharamdas', 'dharmdas': 'dharamdas', 'prahlad': 'prahlad', 'prahalad': 'prahlad',
      'naamdev': 'namdev', 'namdeo': 'namdev', 'ravidas': 'ravidas', 'ravidaas': 'ravidas',
      'dadu': 'dadu', 'dadoo': 'dadu', 'pipa': 'pipa', 'pepa': 'pipa', 'ajamil': 'ajamil', 'ajaamal': 'ajamil'
    };
    let correctedQuery = originalQuery.toLowerCase().trim();
    for (const [wrong, right] of Object.entries(corrections)) {
      if (correctedQuery.includes(wrong)) {
        correctedQuery = correctedQuery.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
      }
    }

    const stopWords = new Set(['what','who','how','why','when','where','which','is','are','was','were','did','does','do','can','tell','me','about','the','a','an','of','in','from','for','to','and','or','by','with','this','that','it','those','these','many','much','full','story','detail','kahani','kya','kaun','kaise','kyun','kab','kahan','batao','bolo','ki','ke','ka','mein','hai','hain','se','ko','ne','par','jo','ye','wo','vo','ek','aur','ya','thi','tha','sab','koi','bahut','konsa','konse','kaunsa','btao','bta','samjhao','samjho']);
    const queryEntities = correctedQuery
      .replace(/[?.,!]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    if (queryEntities.length > 0 && allChunks.length > 0) {
      const allChunkText = allChunks.map(c => c.doc.toLowerCase()).join(' ');
      const entityHits = queryEntities.filter(e => {
        // Check both exact match and substring match (for Hindi inflections)
        return allChunkText.includes(e) || new RegExp(`\\b${e}`, 'i').test(allChunkText);
      });
      const hitRatio = entityHits.length / queryEntities.length;

      if (hitRatio === 0 && queryEntities.length >= 2) {
        // ZERO entities found AND query has real substance → downgrade
        console.log(`[RAG] ENTITY CHECK FAILED: 0/${queryEntities.length} entities found. Entities: [${queryEntities.join(', ')}]`);
        overallConfidence = "NONE";
      } else if (hitRatio < 0.2 && overallConfidence === "HIGH") {
        console.log(`[RAG] ENTITY CHECK WEAK: ${entityHits.length}/${queryEntities.length} entities found. Downgrading HIGH → MEDIUM.`);
        overallConfidence = "MEDIUM";
      } else {
        console.log(`[RAG] ENTITY CHECK OK: ${entityHits.length}/${queryEntities.length} entities found: [${entityHits.join(', ')}]`);
      }
    }

    console.log(`[RAG] FINAL: ${overallConfidence} (${topScoreRaw.toFixed(3)}) | QA: ${validQA.length}/${qaChunks.length} | KB: ${dedupedKB.length} | Total: ${allChunks.length}`);

    return {
      chunks: finalChunks.map(x => ({
        doc: x.doc,
        priority: x.priority,
        source: x.meta?.source || 'Knowledge Base',
        sourceType: x.sourceType,
        confidence: x.confidence,
        similarity: x.similarity
      })),
      sources: finalChunks.map(x => ({
        type: 'kb',
        title: x.meta?.source || 'Knowledge Base',
        url: x.meta?.source || null,
        preview: x.doc.substring(0, 150)
      })),
      overallConfidence,
      topScore: topScoreRaw.toFixed(3),
      queriesUsed: expandQueryLocal(originalQuery)
    };

  } catch (e) {
    console.error('[RAG] Search error:', e.message);
    return { chunks: [], sources: [], overallConfidence: "NONE", topScore: "0.000", queriesUsed: [originalQuery] };
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

      answerInstructions = `${confidenceInstruction}
      
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
    allMessages.push({ role: 'system', content: `IMPORTANT: Answer the user's question using the retrieved context chunks. If the user's query is a follow-up or references facts established in the conversation history, you MUST use the established facts from the history alongside the new context to provide a complete, deep answer. Only use the fallback phrase "The texts I have access to do not specifically address this aspect" as a LAST RESORT if neither context nor history has any relevant facts. Do NOT output this fallback phrase if the answer is logically answerable from the context or the previous turns.` });

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

    const { response, model, is8B } = await callGroqWithFallback(finalMessages);

    // If we got the 8B model, rebuild messages with simpler prompt
    let activeResponse = response;
    if (is8B) {
      console.log('[Groq] 8B model detected — switching to degraded prompt');
      const simplifiedMessages = [
        { role: 'system', content: buildSystemPrompt(true) },
        { role: 'user', content: message }
      ];
      try {
        const retry = await callGroqWithFallback(simplifiedMessages);
        activeResponse = retry.response;
      } catch (e) {
        console.warn('[Groq] 8B retry with simple prompt failed, using original response');
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Active-Model', model);

    let fullText = '';
    for await (const chunk of activeResponse) {
      const text = chunk.choices[0]?.delta?.content;
      if (!text || typeof text !== 'string') continue;
      fullText += text;
      res.write(`data: ${JSON.stringify({
        type: 'token', text
      })}\n\n`);
    }

    // Store in semantic cache for future identical questions
    if (sourceLabel === 'DB' && fullText.length > 50) {
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
      model,
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
      console.log(`[Feedback] Thumbs DOWN for "${query.substring(0,30)}..." - Removed from cache.`);
    }
  } else if (feedback === 1) {
    // User upvoted: Ensure it's in cache and extend TTL to effectively 'remember' it
    console.log(`[Feedback] Thumbs UP for "${query.substring(0,30)}..." - Answer remembered!`);
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
