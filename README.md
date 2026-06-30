# Tatva AI — The Essence of Knowledge

An intelligent AI assistant powered by Groq, with knowledge base support via ChromaDB, multilingual capabilities (Hindi, Hinglish, English, Sanskrit), and conversation history via Supabase.

## What you need (free accounts)

- **Groq API key**: [console.groq.com](https://console.groq.com)
- **Supabase project**: [supabase.com](https://supabase.com)
- **Clerk account**: [clerk.com](https://clerk.com)

## Step 1 — Fill your API keys

Edit `backend/.env`:
```
GROQ_API_KEY=your_real_groq_key
SUPABASE_URL=your_real_supabase_url
SUPABASE_ANON_KEY=your_real_supabase_key
CLERK_SECRET_KEY=your_real_clerk_secret
```

Edit `frontend/.env`:
```
VITE_CLERK_PUBLISHABLE_KEY=your_real_clerk_publishable_key
VITE_BACKEND_URL=http://localhost:5001
```

## Step 2 — Set up database

Go to **Supabase dashboard → SQL Editor**
Paste contents of `backend/supabase-setup.sql` → click **Run**

## Step 3 — Add your knowledge (optional)

Put your PDFs in a folder, then run:
```bash
python3 backend/ingest.py /path/to/your/pdfs/
```

## Step 4 — Start Tatva

```bash
./start.sh
```

Then open [http://localhost:5173](http://localhost:5173)

## Features

- 🧠 **Multi-model AI** — Groq LLaMA 3.3 70B with automatic fallback to 4 other models
- 📖 **Knowledge Base** — Upload PDFs to create a personal knowledge base via ChromaDB
- 🌐 **Web Search** — Automatic web search when knowledge base doesn't have the answer
- 🖼️ **Image Analysis** — Upload images for AI-powered visual analysis
- 🎙️ **Voice Input** — Speak your questions using speech recognition
- 🔊 **Voice Output** — Listen to AI responses with text-to-speech
- 🇮🇳 **Multilingual** — Supports Hindi, Hinglish, English, and Sanskrit
- 💾 **History** — Conversations saved to Supabase
- 🔐 **Auth** — User authentication via Clerk

## Deploy online (free)

- **Frontend** → [Vercel](https://vercel.com) — connect GitHub repo
- **Backend** → [Railway](https://railway.app) — connect GitHub repo
- After deploying, update `VITE_BACKEND_URL` in `frontend/.env` to your Railway backend URL.

## Tech Stack

| Layer      | Technology                            |
|------------|---------------------------------------|
| Frontend   | React + Vite + Tailwind CSS           |
| Backend    | Node.js + Express                     |
| AI         | Groq API (LLaMA 3.3, Mixtral, Gemma) |
| Knowledge  | ChromaDB                              |
| Database   | Supabase (PostgreSQL)                 |
| Auth       | Clerk                                 |
| Design     | Glass morphism, Amber/Indigo palette  |
# tatva
# tat
# tat
# new-tatva-
