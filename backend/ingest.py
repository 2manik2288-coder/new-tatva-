#!/usr/bin/env python3
"""
Tatva AI — Knowledge Base Ingestion Script

Supports:
  PDFs:      python3 ingest.py /path/to/pdfs/
  YouTube:   python3 ingest.py --youtube VIDEO_ID_or_URL
  Web Page:  python3 ingest.py --url https://example.com/article
"""

import sys
import os
import json
import re

# ─── Constants ─────────────────────────────────────────
CHUNK_SIZE = 1200     # ~300 tokens — focused chunks for precise vector retrieval
CHUNK_OVERLAP = 200   # ~17% overlap — preserves context boundaries between chunks
COLLECTION_NAME = "tatva_knowledge"

# ─── Dependency checks ─────────────────────────────────
try:
    import chromadb
except ImportError:
    print("❌ ChromaDB not installed. Run: pip3 install chromadb")
    sys.exit(1)


def chunk_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping chunks for retrieval."""
    chunks = []
    for i in range(0, len(text), chunk_size - overlap):
        chunk = text[i:i + chunk_size].strip()
        if len(chunk) > 30:
            chunks.append(chunk)
    return chunks


def connect_chroma():
    """Connect to ChromaDB and return the collection."""
    print("🔗 Connecting to ChromaDB...")
    try:
        # Connect to the running Chroma server on port 8000
        client = chromadb.HttpClient(host="localhost", port=8000)
        collection = client.get_or_create_collection(name=COLLECTION_NAME)
        print("✅ ChromaDB connected")
        return collection
    except Exception as e:
        print(f"❌ ChromaDB connection failed: {e}")
        print("Make sure ChromaDB is running: chroma run --path ./chroma_db --port 8000")
        sys.exit(1)


# ─── PDF Ingestion ─────────────────────────────────────

def extract_pdf_text(filepath):
    """Extract text from a PDF using PyMuPDF."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("❌ PyMuPDF not installed. Run: pip3 install pymupdf")
        sys.exit(1)

    doc = fitz.open(filepath)
    pages = []
    for page in doc:
        text = page.get_text()
        if len(text.strip()) > 50:
            pages.append(text.strip())
    doc.close()
    return "\n\n".join(pages)


def find_pdfs(folder):
    """Recursively find all PDF, TXT, and MD files in a folder."""
    pdfs = []
    for root, dirs, files in os.walk(folder):
        for file in files:
            ext = file.lower()
            if ext.endswith(".pdf") or ext.endswith(".txt") or ext.endswith(".md"):
                pdfs.append(os.path.join(root, file))
    return sorted(pdfs)


def load_tracker(tracker_path):
    """Load the processed files tracker."""
    if os.path.exists(tracker_path):
        with open(tracker_path, "r") as f:
            return json.load(f)
    return {"processed": []}


def save_tracker(tracker_path, tracker):
    """Save the processed files tracker."""
    with open(tracker_path, "w") as f:
        json.dump(tracker, f, indent=2)


def ingest_pdfs(folder):
    """Ingest all PDFs from a folder into ChromaDB."""
    collection = connect_chroma()
    tracker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tracker.json")
    tracker = load_tracker(tracker_path)

    pdfs = find_pdfs(folder)
    if not pdfs:
        print(f"📂 No PDF files found in '{folder}'")
        return

    print(f"📚 Found {len(pdfs)} PDF(s) in '{folder}'")
    print(f"   Chunk size: {CHUNK_SIZE} chars, overlap: {CHUNK_OVERLAP} chars")
    print("")

    total_chunks = 0
    processed_count = 0
    errors = []

    for idx, pdf_path in enumerate(pdfs, 1):
        filename = os.path.basename(pdf_path)

        if filename in tracker["processed"]:
            print(f"⏭  {filename} — already processed, skipping")
            continue

        try:
            if pdf_path.lower().endswith(".txt") or pdf_path.lower().endswith(".md"):
                with open(pdf_path, "r", encoding="utf-8") as f:
                    text = f.read()
            else:
                text = extract_pdf_text(pdf_path)
            if not text.strip():
                print(f"⚠️  {filename} — no extractable text, skipping")
                tracker["processed"].append(filename)
                save_tracker(tracker_path, tracker)
                continue

            chunks = chunk_text(text)
            if not chunks:
                print(f"⚠️  {filename} — text too short to chunk, skipping")
                tracker["processed"].append(filename)
                save_tracker(tracker_path, tracker)
                continue

            ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
            metadatas = [{"source": filename, "chunk_index": i, "type": "pdf"} for i in range(len(chunks))]
            collection.add(ids=ids, documents=chunks, metadatas=metadatas)

            total_chunks += len(chunks)
            processed_count += 1
            tracker["processed"].append(filename)
            save_tracker(tracker_path, tracker)

            print(f"✅ {filename} — added {len(chunks)} chunks ({idx}/{len(pdfs)} files done)")

        except Exception as e:
            errors.append((filename, str(e)))
            print(f"❌ {filename} — error: {e}")
            continue

    print("")
    print("=" * 50)
    print(f"🎉 Done. Processed {processed_count} new file(s).")
    print(f"📊 Total chunks added this run: {total_chunks}")
    existing = collection.count()
    print(f"📚 Total chunks in knowledge base: {existing}")
    if errors:
        print(f"⚠️  {len(errors)} file(s) had errors:")
        for name, err in errors:
            print(f"   - {name}: {err}")
    print("")
    print("📚 Tatva is ready to answer from your documents.")


# ─── YouTube Ingestion ─────────────────────────────────

def extract_youtube_id(input_str):
    """Extract YouTube video ID from a URL or raw ID."""
    patterns = [
        r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for p in patterns:
        m = re.search(p, input_str)
        if m:
            return m.group(1)
    return None


def ingest_youtube(video_input):
    """Ingest a YouTube video transcript into ChromaDB."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        print("❌ youtube-transcript-api not installed. Run: pip3 install youtube-transcript-api")
        sys.exit(1)

    video_id = extract_youtube_id(video_input)
    if not video_id:
        print(f"❌ Could not extract video ID from: {video_input}")
        sys.exit(1)

    print(f"🎥 Fetching transcript for video: {video_id}")
    try:
        transcript = YouTubeTranscriptApi.get_transcript(video_id)
        text = " ".join([t['text'] for t in transcript])
    except Exception as e:
        print(f"❌ Failed to fetch transcript: {e}")
        print("   The video may not have captions available.")
        sys.exit(1)

    if len(text.strip()) < 100:
        print("⚠️  Transcript too short, skipping.")
        return

    collection = connect_chroma()
    chunks = chunk_text(text)
    source_name = f"YouTube:{video_id}"

    ids = [f"yt_{video_id}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [{"source": source_name, "chunk_index": i, "type": "youtube"} for i in range(len(chunks))]
    collection.add(ids=ids, documents=chunks, metadatas=metadatas)

    print(f"✅ YouTube video {video_id} — added {len(chunks)} chunks")
    print(f"📚 Total chunks in knowledge base: {collection.count()}")


# ─── Web Page Ingestion ────────────────────────────────

def ingest_url(url):
    """Scrape a web page and ingest its text into ChromaDB."""
    try:
        import trafilatura
    except ImportError:
        print("❌ trafilatura not installed. Run: pip3 install trafilatura")
        sys.exit(1)

    print(f"🌐 Fetching: {url}")
    try:
        downloaded = trafilatura.fetch_url(url)
        text = trafilatura.extract(downloaded)
    except Exception as e:
        print(f"❌ Failed to fetch/parse URL: {e}")
        sys.exit(1)

    if not text or len(text.strip()) < 100:
        print("⚠️  No extractable text from this URL.")
        return

    collection = connect_chroma()
    chunks = chunk_text(text)

    # Create a clean source name from the URL
    from urllib.parse import urlparse
    domain = urlparse(url).netloc
    source_name = f"Web:{domain}"

    ids = [f"web_{domain}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [{"source": source_name, "chunk_index": i, "type": "web_page", "url": url} for i in range(len(chunks))]
    collection.add(ids=ids, documents=chunks, metadatas=metadatas)

    print(f"✅ {url} — added {len(chunks)} chunks")
    print(f"📚 Total chunks in knowledge base: {collection.count()}")


# ─── Main ──────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Tatva AI — Knowledge Base Ingestion")
        print("")
        print("Usage:")
        print("  python3 ingest.py /path/to/pdfs/           Ingest PDFs from folder")
        print("  python3 ingest.py --youtube VIDEO_ID        Ingest YouTube transcript")
        print("  python3 ingest.py --youtube URL             Ingest YouTube transcript")
        print("  python3 ingest.py --url https://example.com Ingest web page content")
        print("")
        print(f"Chunk size: {CHUNK_SIZE} chars | Overlap: {CHUNK_OVERLAP} chars")
        sys.exit(0)

    mode = sys.argv[1]

    if mode == "--youtube":
        if len(sys.argv) < 3:
            print("❌ Provide a YouTube video ID or URL")
            sys.exit(1)
        ingest_youtube(sys.argv[2])

    elif mode == "--url":
        if len(sys.argv) < 3:
            print("❌ Provide a URL to scrape")
            sys.exit(1)
        ingest_url(sys.argv[2])

    elif os.path.isdir(mode):
        ingest_pdfs(mode)

    else:
        print(f"❌ '{mode}' is not a valid directory or recognized flag.")
        print("Use --youtube, --url, or provide a folder path.")
        sys.exit(1)


if __name__ == "__main__":
    main()
