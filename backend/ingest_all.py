#!/usr/bin/env python3
"""
Tatva AI — Knowledge Ingestion Script
======================================
Usage:
  python3 ingest_all.py pdf /path/to/folder/
  python3 ingest_all.py yt  https://youtube.com/@Channel
  python3 ingest_all.py web https://example.com
  python3 ingest_all.py stats
  python3 ingest_all.py reset
"""

import sys
import os
import json
import time
import hashlib
import re
from pathlib import Path
from datetime import datetime

# Set Hugging Face Token and load env from .env if present
try:
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    key, val = line.strip().split("=", 1)
                    os.environ[key.strip()] = val.strip()
except Exception as e:
    pass

# ─── CONFIG ──────────────────────────
CHUNK_SIZE    = 1200   # ~300 tokens — focused chunks for precise vector retrieval
CHUNK_OVERLAP = 200    # ~17% overlap — preserves context boundaries between chunks
MIN_CHUNK     = 50
COLLECTION    = "tatva_knowledge"
CHROMA_PATH   = Path(__file__).parent / "chroma_db"
TRACKER_FILE  = Path(__file__).parent / "ingest_tracker.json"
MAX_WEB_PAGES = 2000   # was 500 — crawl much more
MAX_YT_VIDEOS = 1000   # keep same
BATCH_SIZE    = 200    # store in larger batches
# ─────────────────────────────────────

def check_imports():
    missing = []
    try: import fitz
    except: missing.append("pymupdf")
    try: import chromadb
    except: missing.append("chromadb")
    try: from youtube_transcript_api import YouTubeTranscriptApi
    except: missing.append("youtube-transcript-api")
    try: import yt_dlp
    except: missing.append("yt-dlp")
    try: import trafilatura
    except: missing.append("trafilatura")
    try: import bs4
    except: missing.append("beautifulsoup4")
    try: from tqdm import tqdm
    except: missing.append("tqdm")
    if missing:
        print(f"\n❌ Missing packages. Run:")
        print(f"   pip3 install {' '.join(missing)}\n")
        sys.exit(1)

check_imports()

import fitz
import chromadb
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled, NoTranscriptFound
)
import yt_dlp
import trafilatura
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from tqdm import tqdm

# ─── CHROMADB ──────────────────────────────────────────────
def get_collection():
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    collection = client.get_or_create_collection(
        name=COLLECTION,
        metadata={"hnsw:space": "cosine"}
    )
    return collection

# ─── TRACKER ───────────────────────────────────────────────
def load_tracker():
    if TRACKER_FILE.exists():
        with open(TRACKER_FILE) as f:
            return json.load(f)
    return {
        "pdfs": [],
        "youtube": [],
        "websites": [],
        "stats": {"total_chunks": 0, "last_updated": ""}
    }

def save_tracker(tracker):
    tracker["stats"]["last_updated"] = datetime.now().isoformat()
    with open(TRACKER_FILE, "w") as f:
        json.dump(tracker, f, indent=2)

def make_id(text):
    return hashlib.md5(
        text.encode("utf-8", errors="ignore")
    ).hexdigest()

# ─── PDF CLEANING ──────────────────────────────────────────
def extract_and_clean_pdf(pdf_path):
    doc = fitz.open(str(pdf_path))
    page_count = len(doc)
    all_text_parts = []

    for page_num, page in enumerate(doc):
        # Get text
        text = page.get_text("text", sort=True)
        if len(text.strip()) < 30:
            continue

        # Basic cleaning
        text = re.sub(r'-\n(\w)', r'\1', text)
        text = re.sub(
            r'^\s*\d+\s*$', '', text, flags=re.MULTILINE
        )
        text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
        text = re.sub(r' {2,}', ' ', text)
        text = text.strip()

        if len(text) > 30:
            all_text_parts.append(text)

    doc.close()

    # Return full document text for multi-level chunking and page count
    return '\n\n'.join(all_text_parts), page_count

# ─── SMART CHUNKING ────────────────────────────────────────
def chunk_text_smart(text, source_label, source_type="pdf"):
    """
    Multi-level chunking with source type tagging.
    source_type: 'pdf', 'youtube', 'web_page', 'qa', 'sacred_speech'
    1. Sliding window over full text
    2. Paragraph level chunks
    3. Sentence level chunks for dense content
    All combined and deduplicated
    """
    if not text or len(text.strip()) < MIN_CHUNK:
        return []

    # ── Check Sentence Boundary Density (scanned PDF detection) ──
    # Look for periods, exclamation/question marks, single and double dandas
    boundary_count = len(re.findall(r'[.!?।॥]|।।', text))
    char_count = len(text)
    density = (boundary_count / char_count) * 1000 if char_count > 0 else 0
    if char_count > 1000 and density < 0.5:
        print(f"\n   ⚠️  WARNING: Extremely low sentence boundary density ({density:.2f} per 1k chars) in \"{source_label}\".")
        print(f"       This PDF may be scanned, image-only, or require OCR. Chunks might be fragmented.")

    all_chunks = set()  # use set to auto-deduplicate
    chunk_list = []

    # ── LEVEL 1: Sliding window over entire text ──────────
    # This is the main chunking — captures everything
    text_clean = re.sub(r'\s+', ' ', text).strip()
    start = 0
    while start < len(text_clean):
        end = start + CHUNK_SIZE
        chunk = text_clean[start:end].strip()
        if len(chunk) >= MIN_CHUNK:
            chunk_id = make_id(chunk + source_label)
            if chunk_id not in all_chunks:
                all_chunks.add(chunk_id)
                chunk_list.append({
                    "text": chunk,
                    "source": source_label,
                    "type": source_type,
                    "id": chunk_id
                })
        start += CHUNK_SIZE - CHUNK_OVERLAP

    # ── LEVEL 2: Paragraph level chunks ───────────────────
    # Split on double newlines — captures full ideas
    paragraphs = re.split(r'\n\s*\n', text)
    for para in paragraphs:
        para = para.strip()
        if len(para) < MIN_CHUNK:
            continue
        # If paragraph is long, sub-chunk it
        if len(para) > CHUNK_SIZE:
            sub_start = 0
            while sub_start < len(para):
                sub = para[sub_start:sub_start+CHUNK_SIZE].strip()
                if len(sub) >= MIN_CHUNK:
                    chunk_id = make_id(sub + source_label)
                    if chunk_id not in all_chunks:
                        all_chunks.add(chunk_id)
                        chunk_list.append({
                            "text": sub,
                            "source": source_label,
                            "type": source_type,
                            "id": chunk_id
                        })
                sub_start += CHUNK_SIZE - CHUNK_OVERLAP
        else:
            chunk_id = make_id(para + source_label)
            if chunk_id not in all_chunks:
                all_chunks.add(chunk_id)
                chunk_list.append({
                    "text": para,
                    "source": source_label,
                    "type": source_type,
                    "id": chunk_id
                })

    # ── LEVEL 3: Sentence level chunks ────────────────────
    # Split on sentence endings — supports English and Devanagari sentence endings (.!?।॥ or double danda)
    sentences = re.split(
        r'(?<=[.!?।॥])\s*|(?<=।।)\s*', text
    )
    current_sent = ""
    for sent in sentences:
        if not sent:
            continue
        sent = sent.strip()
        if not sent:
            continue
        if len(current_sent) + len(sent) < CHUNK_SIZE:
            current_sent += " " + sent if current_sent else sent
        else:
            if len(current_sent) >= MIN_CHUNK:
                chunk_id = make_id(current_sent + source_label)
                if chunk_id not in all_chunks:
                    all_chunks.add(chunk_id)
                    chunk_list.append({
                        "text": current_sent.strip(),
                        "source": source_label,
                        "type": source_type,
                        "id": chunk_id
                    })
            current_sent = sent
    # Last sentence group
    if len(current_sent) >= MIN_CHUNK:
        chunk_id = make_id(current_sent + source_label)
        if chunk_id not in all_chunks:
            all_chunks.add(chunk_id)
            chunk_list.append({
                "text": current_sent.strip(),
                "source": source_label,
                "type": source_type,
                "id": chunk_id
            })

    return chunk_list

# ─── STORE CHUNKS ──────────────────────────────────────────
def store_chunks(collection, chunks, batch_size=200):
    if not chunks:
        return 0
    # Check existing in batches to avoid timeout
    existing_ids = set()
    check_size = 500
    for i in range(0, len(chunks), check_size):
        batch_ids = [c["id"] for c in chunks[i:i+check_size]]
        try:
            existing = collection.get(ids=batch_ids)
            existing_ids.update(existing["ids"])
        except:
            pass

    new = [c for c in chunks if c["id"] not in existing_ids]
    if not new:
        return 0

    added = 0
    for i in range(0, len(new), batch_size):
        batch = new[i:i+batch_size]
        try:
            collection.add(
                documents=[c["text"] for c in batch],
                metadatas=[
                    {"source": c["source"], "type": c.get("type", "pdf")} for c in batch
                ],
                ids=[c["id"] for c in batch]
            )
            added += len(batch)
        except Exception as e:
            print(f"\n  ⚠️ Batch error: {e}")
            # Try one by one if batch fails
            for c in batch:
                try:
                    collection.add(
                        documents=[c["text"]],
                        metadatas=[{"source": c["source"], "type": c.get("type", "pdf")}],
                        ids=[c["id"]]
                    )
                    added += 1
                except:
                    pass
    return added

# ════════════════════════════════════════
# PDF INGESTION
# ════════════════════════════════════════
def ingest_pdfs(folder_path):
    print(f"\n📚 PDF INGESTION")
    print(f"   Scanning: {folder_path}")
    print("─" * 50)
    folder = Path(folder_path)
    if not folder.exists():
        print(f"❌ Folder not found: {folder_path}")
        return 0
    all_pdfs = list(folder.rglob("*.pdf"))
    print(f"   Found {len(all_pdfs)} PDFs in all subfolders\n")
    tracker = load_tracker()
    collection = get_collection()
    total = skipped = failed = 0
    for i, pdf_path in enumerate(
        tqdm(all_pdfs, desc="Processing PDFs")
    ):
        key = str(pdf_path)
        if key in tracker["pdfs"]:
            skipped += 1
            continue
        try:
            full_text, page_count = extract_and_clean_pdf(pdf_path)
            if len(full_text.strip()) < MIN_CHUNK:
                tracker["pdfs"].append(key)
                save_tracker(tracker)
                continue
            rel = str(pdf_path.relative_to(folder))
            chunks = chunk_text_smart(full_text, f"PDF: {rel}", source_type="pdf")
            added = store_chunks(collection, chunks)
            total += added
            tracker["pdfs"].append(key)
            save_tracker(tracker)
            print(f"\n   📄 {pdf_path.name} | Pages: {page_count} | Chunks: {len(chunks)} (New added: {added})")
            if (i + 1) % 10 == 0:
                print(f"\n   ✅ {i+1}/{len(all_pdfs)} done"
                      f" — {total} chunks so far")
        except Exception as e:
            failed += 1
            print(f"\n   ❌ Failed: {pdf_path.name} — {e}")
            continue
    print(f"\n   📊 PDF Summary:")
    print(f"   ✅ Processed: {len(all_pdfs)-skipped-failed}")
    print(f"   ⏭️  Skipped (already done): {skipped}")
    print(f"   ❌ Failed: {failed}")
    print(f"   💾 New chunks added: {total}")
    return total

# ════════════════════════════════════════
# YOUTUBE INGESTION
# ════════════════════════════════════════
def get_all_video_ids(url):
    print(f"   Fetching video list from: {url}")
    ydl_opts = {
        'quiet': True,
        'extract_flat': True,
        'skip_download': True,
        'playlistend': MAX_YT_VIDEOS,
    }
    ids = []
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info is None:
                return []
            if 'entries' in info:
                for e in info['entries']:
                    if e and e.get('id'):
                        ids.append(e['id'])
            elif info.get('id'):
                ids.append(info['id'])
    except Exception as e:
        print(f"   ❌ Could not fetch list: {e}")
        return []
    print(f"   Found {len(ids)} videos")
    return ids

def get_transcript(video_id):
    try:
        tlist = YouTubeTranscriptApi.list_transcripts(video_id)
        for lang in ['en', 'hi', 'en-IN', 'en-GB']:
            try:
                t = tlist.find_transcript([lang])
                data = t.fetch()
                return " ".join([x['text'] for x in data]), lang
            except:
                continue
        try:
            t = tlist.find_generated_transcript(['en', 'hi'])
            data = t.fetch()
            return " ".join([x['text'] for x in data]), 'auto'
        except:
            pass
        for t in tlist:
            data = t.fetch()
            return (
                " ".join([x['text'] for x in data]),
                t.language_code
            )
    except TranscriptsDisabled:
        return None, "disabled"
    except NoTranscriptFound:
        return None, "not_found"
    except Exception as e:
        return None, str(e)

def ingest_youtube(url):
    print(f"\n🎬 YOUTUBE INGESTION")
    print(f"   Source: {url}")
    print("─" * 50)
    tracker = load_tracker()
    collection = get_collection()
    ids = get_all_video_ids(url)
    if not ids:
        print("   ❌ No videos found")
        return 0
    total = success = skipped = no_transcript = 0
    for i, vid_id in enumerate(
        tqdm(ids, desc="Processing videos")
    ):
        key = f"yt:{vid_id}"
        if key in tracker["youtube"]:
            skipped += 1
            continue
        text, lang = get_transcript(vid_id)
        tracker["youtube"].append(key)
        save_tracker(tracker)
        if not text or len(text.strip()) < MIN_CHUNK:
            no_transcript += 1
            continue
        src = (f"YouTube: "
               f"https://youtube.com/watch?v={vid_id}"
               f" [{lang}]")
        chunks = chunk_text_smart(text, src, source_type="youtube")
        added = store_chunks(collection, chunks)
        total += added
        success += 1
        time.sleep(0.3)
        if (i + 1) % 20 == 0:
            print(f"\n   ✅ {i+1}/{len(ids)} videos"
                  f" — {total} chunks so far")
    print(f"\n   📊 YouTube Summary:")
    print(f"   ✅ Transcripts fetched: {success}")
    print(f"   ⏭️  Skipped: {skipped}")
    print(f"   🚫 No transcript: {no_transcript}")
    print(f"   💾 New chunks: {total}")
    return total

# ════════════════════════════════════════
# WEBSITE INGESTION
# ════════════════════════════════════════
def get_links(url, session, visited, base_domain):
    links = set()
    try:
        r = session.get(url, timeout=10)
        if 'text/html' not in r.headers.get(
            'Content-Type', ''
        ):
            return links
        soup = BeautifulSoup(r.text, 'html.parser')
        for tag in soup.find_all('a', href=True):
            full = urljoin(url, tag['href'])
            p = urlparse(full)
            if p.netloc == base_domain:
                clean = p._replace(fragment='').geturl()
                skip = [
                    '.pdf', '.jpg', '.png', '.gif',
                    '.zip', '.mp4', '.mp3',
                    'mailto:', 'javascript:',
                    '/login', '/signup', '/cart',
                    '/wp-admin', '/wp-json', '/cdn-cgi'
                ]
                if not any(
                    s in clean.lower() for s in skip
                ):
                    if clean not in visited:
                        links.add(clean)
    except:
        pass
    return links

def extract_page(url, session):
    try:
        r = session.get(url, timeout=10)
        if r.status_code != 200:
            return None
        if 'text/html' not in r.headers.get(
            'Content-Type', ''
        ):
            return None
        text = trafilatura.extract(
            r.text,
            include_tables=True,
            include_links=False,
            no_fallback=False
        )
        return text
    except:
        return None

def ingest_website(base_url):
    print(f"\n🌐 WEBSITE INGESTION")
    print(f"   Source: {base_url}")
    print(f"   Crawling up to {MAX_WEB_PAGES} pages")
    print("─" * 50)
    tracker = load_tracker()
    collection = get_collection()
    parsed = urlparse(base_url)
    base_domain = parsed.netloc
    session = requests.Session()
    session.headers['User-Agent'] = (
        'Mozilla/5.0 TatvaBot/1.0'
    )
    to_visit = {base_url}
    visited = set()
    total = success = skipped = no_text = 0
    with tqdm(desc="Crawling pages", unit="page") as pbar:
        while to_visit and len(visited) < MAX_WEB_PAGES:
            url = to_visit.pop()
            if url in visited:
                skipped += 1
                continue
            visited.add(url)
            key = f"web_page:{url}"
            if key in tracker["websites"]:
                skipped += 1
                new_links = get_links(
                    url, session, visited, base_domain
                )
                to_visit.update(new_links)
                pbar.update(1)
                continue
            text = extract_page(url, session)
            tracker["websites"].append(key)
            save_tracker(tracker)
            if not text or len(text.strip()) < MIN_CHUNK:
                no_text += 1
                new_links = get_links(
                    url, session, visited, base_domain
                )
                to_visit.update(new_links)
                pbar.update(1)
                continue
            chunks = chunk_text_smart(
                text, f"Website: {url}", source_type="web_page"
            )
            added = store_chunks(collection, chunks)
            total += added
            success += 1
            new_links = get_links(
                url, session, visited, base_domain
            )
            to_visit.update(new_links - visited)
            pbar.set_postfix(
                pages=success,
                chunks=total,
                queue=len(to_visit)
            )
            pbar.update(1)
            time.sleep(0.5)
    print(f"\n   📊 Website Summary:")
    print(f"   ✅ Pages ingested: {success}")
    print(f"   ⏭️  Skipped: {skipped}")
    print(f"   🚫 No text: {no_text}")
    print(f"   💾 New chunks: {total}")
    return total

# ════════════════════════════════════════
# STATS
# ════════════════════════════════════════
def show_stats():
    try:
        col = get_collection()
        count = col.count()
        tracker = load_tracker()
        pdfs = len(tracker['pdfs'])
        vids = len([
            y for y in tracker['youtube']
            if y.startswith('yt:')
        ])
        pages = len([
            w for w in tracker['websites']
            if w.startswith('web_page:')
        ])
        print(f"""
╔══════════════════════════════════════╗
║     TATVA KNOWLEDGE BASE STATS       ║
╠══════════════════════════════════════╣
║  Total chunks  : {str(count).ljust(18)} ║
║  PDFs          : {str(pdfs).ljust(18)} ║
║  YT videos     : {str(vids).ljust(18)} ║
║  Web pages     : {str(pages).ljust(18)} ║
╚══════════════════════════════════════╝
        """)
        if count > 0:
            results = col.query(
                query_texts=["spiritual knowledge god"],
                n_results=2
            )
            docs = results['documents'][0]
            dists = results['distances'][0]
            print("  🔍 Test query:")
            for i, (doc, dist) in enumerate(
                zip(docs, dists)
            ):
                print(f"  [{i+1}] dist={dist:.3f}")
                print(f"       {doc[:120]}...")
    except Exception as e:
        print(f"❌ Stats error: {e}")

# ════════════════════════════════════════
# RESET
# ════════════════════════════════════════
def reset_database():
    import shutil
    print("⚠️  Clearing ingestion tracker only...")
    if TRACKER_FILE.exists():
        TRACKER_FILE.unlink()
        print("  ✅ Tracker cleared")
    print("  ℹ️  ChromaDB data kept intact")
    print("  Run ingestion again to add new data")

# ════════════════════════════════════════
# MAIN
# ════════════════════════════════════════
def print_usage():
    print("""
╔══════════════════════════════════════════════╗
║      Tatva AI — Knowledge Ingestion          ║
╠══════════════════════════════════════════════╣
║  pdf   /path/to/folder  — ingest all PDFs    ║
║  yt    https://youtube  — channel/playlist   ║
║  web   https://site.com — entire website     ║
║  stats                  — show DB stats      ║
║  reset                  — clear tracker      ║
╚══════════════════════════════════════════════╝
    """)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(0)

    cmd = sys.argv[1].lower()
    total = 0

    if cmd == "pdf":
        if len(sys.argv) < 3:
            print("Usage: python3 ingest_all.py pdf /path/")
            sys.exit(1)
        total = ingest_pdfs(sys.argv[2])

    elif cmd == "yt":
        if len(sys.argv) < 3:
            print("Usage: python3 ingest_all.py yt URL")
            sys.exit(1)
        total = ingest_youtube(sys.argv[2])

    elif cmd == "web":
        if len(sys.argv) < 3:
            print("Usage: python3 ingest_all.py web URL")
            sys.exit(1)
        total = ingest_website(sys.argv[2])

    elif cmd == "stats":
        show_stats()
        sys.exit(0)

    elif cmd == "reset":
        reset_database()
        sys.exit(0)

    else:
        print(f"❌ Unknown: {cmd}")
        print_usage()
        sys.exit(1)

    show_stats()
    print(f"\n✅ Done. New chunks this session: {total}\n")
