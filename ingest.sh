#!/bin/bash
# ─────────────────────────────────────────────
#  Tatva AI — One-Command Knowledge Ingestion
# ─────────────────────────────────────────────
#  Ingests all PDFs, YouTube links, and web
#  pages from the knowledge/ folder into ChromaDB.
#
#  Usage:  ./ingest.sh
# ─────────────────────────────────────────────

set -e
cd "$(dirname "$0")"

KNOWLEDGE_DIR="./knowledge"
INGEST_SCRIPT="./backend/ingest.py"
LINKS_FILE="$KNOWLEDGE_DIR/links.json"
PDF_DIR="$KNOWLEDGE_DIR/pdfs"

echo ""
echo "  त  Tatva AI — Knowledge Ingestion"
echo "  ─────────────────────────────────"
echo ""

# ── 1. Ingest Documents ───────────────────────
DOC_COUNT=$(find "$PDF_DIR" -type f \( -name "*.pdf" -o -name "*.txt" -o -name "*.md" \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$DOC_COUNT" -gt 0 ]; then
  echo "📄 Found $DOC_COUNT document(s) in knowledge/pdfs/"
  python3 "$INGEST_SCRIPT" "$PDF_DIR"
  echo ""
else
  echo "📄 No documents found in knowledge/pdfs/ — skipping"
  echo ""
fi

# ── 2. Ingest YouTube links ────────────────
if [ -f "$LINKS_FILE" ]; then
  YT_LINKS=$(python3 -c "
import json, sys
try:
    data = json.load(open('$LINKS_FILE'))
    links = data.get('youtube', [])
    for l in links:
        if l.strip():
            print(l.strip())
except:
    pass
" 2>/dev/null)

  if [ -n "$YT_LINKS" ]; then
    YT_COUNT=$(echo "$YT_LINKS" | wc -l | tr -d ' ')
    echo "🎥 Found $YT_COUNT YouTube link(s)"
    echo "$YT_LINKS" | while IFS= read -r link; do
      echo "   → Ingesting: $link"
      python3 "$INGEST_SCRIPT" --youtube "$link" || echo "   ⚠️  Failed: $link"
    done
    echo ""
  else
    echo "🎥 No YouTube links in links.json — skipping"
    echo ""
  fi
else
  echo "🎥 links.json not found — skipping YouTube"
  echo ""
fi

# ── 3. Ingest web pages ───────────────────
if [ -f "$LINKS_FILE" ]; then
  WEB_LINKS=$(python3 -c "
import json, sys
try:
    data = json.load(open('$LINKS_FILE'))
    links = data.get('webpages', [])
    for l in links:
        if l.strip():
            print(l.strip())
except:
    pass
" 2>/dev/null)

  if [ -n "$WEB_LINKS" ]; then
    WEB_COUNT=$(echo "$WEB_LINKS" | wc -l | tr -d ' ')
    echo "🌐 Found $WEB_COUNT web page link(s)"
    echo "$WEB_LINKS" | while IFS= read -r link; do
      echo "   → Ingesting: $link"
      python3 "$INGEST_SCRIPT" --url "$link" || echo "   ⚠️  Failed: $link"
    done
    echo ""
  else
    echo "🌐 No web page links in links.json — skipping"
    echo ""
  fi
else
  echo "🌐 links.json not found — skipping web pages"
  echo ""
fi

echo "  ─────────────────────────────────"
echo "  ✅ Ingestion complete!"
echo "  त  Tatva is ready."
echo ""
