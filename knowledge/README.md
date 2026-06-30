# Tatva AI — Knowledge Base

Drop your files and links here. Then run the ingest script to feed them to Tatva.

## 📂 Structure

```
knowledge/
├── pdfs/          ← Drop PDF files here (books, articles, docs)
├── links.json     ← Paste YouTube & web page URLs here
└── README.md      ← This file
```

## 📄 PDFs
Just drag-and-drop your PDF files into the `pdfs/` folder. Any `.pdf` file placed here (including in subfolders) will be automatically picked up.

## 🎥 YouTube Videos
Open `links.json` and add YouTube URLs or video IDs to the `"youtube"` array:

```json
{
  "youtube": [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "abc123DEF_g"
  ],
  "webpages": []
}
```

## 🌐 Web Pages
Open `links.json` and add page URLs to the `"webpages"` array:

```json
{
  "youtube": [],
  "webpages": [
    "https://en.wikipedia.org/wiki/Vedanta",
    "https://example.com/article"
  ]
}
```

## 🚀 Ingest Everything

Run one command to ingest all PDFs + YouTube + web pages:

```bash
cd ~/Desktop/tatva
./ingest.sh
```

Or ingest individually:

```bash
python3 backend/ingest.py knowledge/pdfs/           # PDFs only
python3 backend/ingest.py --youtube VIDEO_ID         # Single YouTube
python3 backend/ingest.py --url https://example.com  # Single web page
```

## ⚠️ Requirements

Make sure ChromaDB is running before ingesting:
```bash
chroma run
```

Install optional dependencies for YouTube/web:
```bash
pip3 install youtube-transcript-api trafilatura
```
