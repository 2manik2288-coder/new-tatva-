#!/usr/bin/env python3
"""
Tatva AI — Knowledge Ingestion Script (v2 — Multilingual)
==========================================================
Usage:
  python3 ingest_all.py pdf /path/to/folder/
  python3 ingest_all.py pdf /path/to/folder/ --collection tatva_knowledge_v2
  python3 ingest_all.py yt  https://youtube.com/@Channel
  python3 ingest_all.py web https://example.com
  python3 ingest_all.py stats
  python3 ingest_all.py stats --collection tatva_knowledge_v2
  python3 ingest_all.py reset
"""

import sys
import os

# ─── macOS SAFETY: set spawn before any torch/model imports ───
import multiprocessing
if sys.platform == "darwin":
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass  # already set

import json
import time
import hashlib
import re
import traceback
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

# ─── DEVICE AUTO-DETECTION ────────────────────
import torch
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"
else:
    DEVICE = "cpu"
print(f"[Ingest] Using device: {DEVICE}")

# ─── EMBEDDING MODEL (Multilingual — Hindi/Sanskrit support) ──
from sentence_transformers import SentenceTransformer
EMBED_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
print(f"[Ingest] Loading embedding model: {EMBED_MODEL_NAME}")
embed_model = SentenceTransformer(EMBED_MODEL_NAME, device=DEVICE)
print(f"[Ingest] Model loaded. Embedding dimension: {embed_model.get_sentence_embedding_dimension()}")

# ─── CONFIG ──────────────────────────────────
CHUNK_SIZE    = 1200   # ~300 tokens — focused chunks for precise vector retrieval
CHUNK_OVERLAP = 200    # ~17% overlap — preserves context boundaries between chunks
MIN_CHUNK     = 50
COLLECTION    = "tatva_knowledge"      # Default to the restored 451,859-chunk collection
CHROMA_PATH   = Path(__file__).parent / "chroma_db.nosync"
TRACKER_FILE  = Path(__file__).parent / "ingest_tracker.json"
FAILED_LOG    = Path(__file__).parent / "ingest_failed.log"
MAX_WEB_PAGES = 2000   # was 500 — crawl much more
MAX_YT_VIDEOS = 1000   # keep same
BATCH_SIZE    = 200    # store in larger batches
# ─────────────────────────────────────────────

# ─── TIER-1 FILENAMES (Sant Rampal Ji Maharaj's books) ────────
# These are the authoritative primary source books.
# All other PDFs (Vedas, Mahabharata, Ramayana, etc.) are tier-2.
TIER_1_FILENAMES = {
    'gyan_ganga_hindi',
    'dharti-swarg-banana-hai',
    'hindu-saheban-nahin-samjhe-gita-ved-puran_lts',
    'dharti_par_avtar',
    'adhyatmik_gyan_ganga',
    'andh_shradha_khatra_e_jaan',
    'aag',
    'muktibodh',
    'marathi-hindu-dharam-mahan',
    'kabir-bada-ya-krishna',
    'adhyatm-gyan-roopi-tob-ka-gola',
    'jeene-ki-rah',
    'babpart1',
    'bhakti_se_bhagwan_tak',
    'kabir-parmeshwar',
    'babpart2',
    'kkkr',
    'musalman-nahin-samjhe-gyan-quran',
    'hindu-dharam-mahan',
    'bhaktibodh_hindi_lts-1',
    'srishti_rachna_vistrit',
    'kabir-sagar-ka-sarlarth',
    'yatharth_kabir_panth_parichay',
}
# ─────────────────────────────────────────────

def get_source_tier(pdf_path):
    """Determine source tier from filename.
    Tier 1 = Sant Rampal Ji Maharaj's books (authoritative)
    Tier 2 = Original scriptures (supporting pramaan)
    """
    stem = Path(pdf_path).stem.lower()
    # Strip leading numeric prefix (e.g., "1774070962947-")
    clean = re.sub(r'^\d+-', '', stem)
    return 1 if clean in TIER_1_FILENAMES else 2

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
from chromadb.api.types import EmbeddingFunction, Documents, Embeddings
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

# ─── CUSTOM EMBEDDING FUNCTION FOR CHROMADB ───────────────
class MultilingualEmbedder(EmbeddingFunction):
    """ChromaDB-compatible embedding function using the multilingual model."""
    def __init__(self) -> None:
        pass

    def __call__(self, input: Documents) -> Embeddings:
        embeddings = embed_model.encode(
            input,
            normalize_embeddings=True,
            show_progress_bar=False
        )
        return embeddings.tolist()

    def name(self) -> str:
        return "sentence_transformer"

multilingual_embedder = MultilingualEmbedder()

# ─── CHROMADB ──────────────────────────────────────────────
def get_collection(collection_name=None):
    name = collection_name or COLLECTION
    # Try connecting via HttpClient first if server is running on port 8000
    try:
        import requests
        resp = requests.get("http://localhost:8000/api/v2/heartbeat", timeout=2)
        if resp.status_code == 200:
            print("🔗 Connecting to running ChromaDB server via HttpClient (localhost:8000)...")
            client = chromadb.HttpClient(host="localhost", port=8000)
            collection = client.get_or_create_collection(
                name=name,
                metadata={"hnsw:space": "cosine"},
                embedding_function=multilingual_embedder
            )
            return collection
    except Exception:
        pass

    # Fallback to direct PersistentClient pointing to chroma_db.nosync
    print(f"📁 Connecting directly to ChromaDB PersistentClient (path: {CHROMA_PATH.resolve()})...")
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    collection = client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
        embedding_function=multilingual_embedder
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

# ─── FAILURE LOGGING ──────────────────────────────────────
def log_failure(pdf_path, error):
    """Log a failed PDF ingestion to ingest_failed.log."""
    with open(FAILED_LOG, "a") as f:
        f.write(f"[{datetime.now().isoformat()}] FAILED: {pdf_path}\n")
        f.write(f"  Error: {error}\n")
        f.write(f"  Traceback:\n")
        f.write(f"  {traceback.format_exc()}\n\n")

# ─── OCR AVAILABILITY CHECK ────────────────────────────────
_ocr_available = None  # cached result

def check_ocr_available():
    """Check once if tesseract + pdf2image + pytesseract are installed."""
    global _ocr_available
    if _ocr_available is not None:
        return _ocr_available
    try:
        import subprocess
        import pytesseract
        from pdf2image import convert_from_path
        result = subprocess.run(
            ['tesseract', '--version'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        _ocr_available = (result.returncode == 0)
    except Exception:
        _ocr_available = False
    return _ocr_available

# ─── TEXT QUALITY DETECTION ────────────────────────────────
GARBLED_CHARS = set('ǥÊďȉȷɉ¹¾ČȑĐĉŘɓǧÇ')

def is_text_garbled(text):
    """Detect if extracted text is garbled (broken CMap / legacy Hindi font).
    Returns (is_garbled: bool, reason: str)
    """
    if len(text.strip()) < 50:
        return False, "too_short"

    garbled_count = sum(1 for c in text if c in GARBLED_CHARS)
    if garbled_count > 5:
        return True, f"garbled_chars={garbled_count}"

    # Check Devanagari vs Latin ratio — Hindi PDFs with legacy fonts
    # produce mostly Latin characters instead of Devanagari
    devanagari = sum(1 for c in text if '\u0900' <= c <= '\u097F')
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    total_alpha = devanagari + latin

    if total_alpha > 100 and devanagari == 0 and latin > 100:
        return True, f"all_latin_no_devanagari (latin={latin})"

    return False, "clean"

def is_pdf_scanned(doc, sample_pages=5):
    """Check if a PDF is scanned (image-only, no text layer).
    Samples the first N pages for text content and images.
    """
    pages_to_check = min(sample_pages, len(doc))
    text_chars = 0
    has_images = False
    for i in range(pages_to_check):
        page = doc[i]
        text = page.get_text("text")
        text_chars += len(text.strip())
        if page.get_images(full=True):
            has_images = True
    # Scanned = has images but essentially no text
    return text_chars < 50 and has_images

# ─── OCR EXTRACTION ───────────────────────────────────────
def extract_text_ocr(pdf_path, page_count):
    """Extract text from a PDF using OCR (Tesseract + pdf2image).
    Returns extracted text string.
    Raises RuntimeError if OCR dependencies are not installed.
    """
    if not check_ocr_available():
        raise RuntimeError(
            "OCR required but not installed. Run:\n"
            "  brew install tesseract tesseract-lang poppler\n"
            "  pip3 install pdf2image pytesseract"
        )

    import pytesseract
    from pdf2image import convert_from_path

    # Detect available Tesseract languages
    available_langs = pytesseract.get_languages()
    ocr_lang = []
    for lang in ['hin', 'san', 'eng']:
        if lang in available_langs:
            ocr_lang.append(lang)
    lang_str = '+'.join(ocr_lang) if ocr_lang else 'eng'

    print(f"\n   🔍 OCR: Converting {page_count} pages to images (300 DPI)...")
    pages = convert_from_path(str(pdf_path), dpi=300)

    all_text_parts = []
    for page_idx, page_img in enumerate(pages):
        if (page_idx + 1) % 50 == 0 or page_idx == 0:
            print(f"   🔍 OCR: Processing page {page_idx + 1}/{page_count}...")

        text = pytesseract.image_to_string(page_img, lang=lang_str)
        # Clean extracted text
        text = re.sub(r'-\n(\w)', r'\1', text)
        text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
        text = re.sub(r' {2,}', ' ', text).strip()
        if len(text) > 30:
            all_text_parts.append(text)

    return '\n\n'.join(all_text_parts)

# ─── PDF CLEANING (with auto-detection) ───────────────────
def extract_and_clean_pdf(pdf_path, ocr=False):
    """Extract text from a PDF.

    Modes:
      ocr=True  → force OCR on every page (--ocr flag)
      ocr=False → try direct extraction first, auto-detect problems,
                   and fall back to OCR if text is garbled or missing

    Returns (text, page_count).
    """
    doc = fitz.open(str(pdf_path))
    page_count = len(doc)

    # ── Forced OCR mode ──
    if ocr:
        doc.close()
        text = extract_text_ocr(pdf_path, page_count)
        return text, page_count

    # ── Auto-detect: is this a scanned PDF? ──
    if is_pdf_scanned(doc):
        doc.close()
        print(f"\n   📸 {pdf_path.name}: Scanned/image-only PDF detected ({page_count} pages)")
        try:
            text = extract_text_ocr(pdf_path, page_count)
            return text, page_count
        except RuntimeError as e:
            print(f"\n   ⚠️  {e}")
            print(f"   ⏭️  Skipping {pdf_path.name} (cannot extract without OCR)")
            return "", page_count

    # ── Try direct text extraction ──
    all_text_parts = []
    for page_num, page in enumerate(doc):
        text = page.get_text("text", sort=True)
        if len(text.strip()) < 30:
            continue
        # Basic cleaning
        text = re.sub(r'-\n(\w)', r'\1', text)
        text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
        text = re.sub(r' {2,}', ' ', text)
        text = text.strip()
        if len(text) > 30:
            all_text_parts.append(text)

    doc.close()
    full_text = '\n\n'.join(all_text_parts)

    # ── Auto-detect: is the extracted text garbled? ──
    garbled, reason = is_text_garbled(full_text)
    if garbled:
        print(f"\n   ⚠️  {pdf_path.name}: Garbled text detected ({reason})")
        try:
            text = extract_text_ocr(pdf_path, page_count)
            return text, page_count
        except RuntimeError as e:
            print(f"\n   ⚠️  {e}")
            print(f"   ⏭️  Skipping {pdf_path.name} (garbled text, cannot OCR)")
            return "", page_count

    return full_text, page_count

# ─── SMART CHUNKING ────────────────────────────────────────
def chunk_text_smart(text, source_label, source_type="pdf", source_tier=2):
    """
    Multi-level chunking with source type and tier tagging.
    source_type: 'pdf', 'youtube', 'web_page', 'qa', 'sacred_speech'
    source_tier: 1 (Sant Rampal Ji books) or 2 (original scriptures/other)
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
                    "source_tier": source_tier,
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
                            "source_tier": source_tier,
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
                    "source_tier": source_tier,
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
                        "source_tier": source_tier,
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
                "source_tier": source_tier,
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
                    {
                        "source": c["source"],
                        "type": c.get("type", "pdf"),
                        "source_tier": c.get("source_tier", 2)
                    } for c in batch
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
                        metadatas=[{
                            "source": c["source"],
                            "type": c.get("type", "pdf"),
                            "source_tier": c.get("source_tier", 2)
                        }],
                        ids=[c["id"]]
                    )
                    added += 1
                except:
                    pass
    return added

# ════════════════════════════════════════
# PDF INGESTION
# ════════════════════════════════════════
def ingest_pdfs(folder_path, collection_name=None, force=False, ocr=False, folder_tier=None):
    print(f"\n📚 PDF INGESTION")
    folder = Path(folder_path)
    resolved_path = folder.resolve()
    print(f"   Scanning: {folder_path} (Resolved: {resolved_path})")
    print(f"   Embedding model: {EMBED_MODEL_NAME}")
    print(f"   Device: {DEVICE}")

    # Show active mode flags
    modes = []
    if force: modes.append("--force (re-ingest all)")
    if ocr:   modes.append("--ocr (forced OCR)")
    if folder_tier is not None: modes.append(f"override-tier (T{folder_tier})")
    if modes:
        print(f"   Mode: {', '.join(modes)}")

    # Show OCR availability
    ocr_ready = check_ocr_available()
    if ocr_ready:
        print(f"   OCR: ✅ Available (tesseract + pdf2image)")
    else:
        print(f"   OCR: ❌ Not installed (scanned/garbled PDFs will be skipped)")
        print(f"         To enable: brew install tesseract tesseract-lang poppler && pip3 install pdf2image pytesseract")

    print("─" * 50)
    if not folder.exists():
        print(f"❌ Folder not found: '{folder_path}' (Resolved: '{resolved_path}')")
        parent = folder.parent
        if parent.exists():
            print(f"   Parent folder '{parent.resolve()}' exists. Available subfolders:")
            for sub in parent.iterdir():
                if sub.is_dir() and not sub.name.startswith('.'):
                    print(f"      - {sub.name}/")
        return 0, 0, 0, 0

    # Warn about iCloud Drive placeholder files
    icloud_files = list(folder.rglob(".*.icloud"))
    if icloud_files:
        print(f"⚠️  WARNING: Found {len(icloud_files)} iCloud placeholder file(s) (not downloaded locally):")
        for f in icloud_files[:10]:
            print(f"      • {f.name}")
        if len(icloud_files) > 10:
            print(f"      • ... and {len(icloud_files) - 10} more.")
        print("   Please open Finder, locate these files, and click the cloud download icon before ingesting.\n")

    # Recursively scan ALL subfolders for PDFs
    all_pdfs = list(folder.rglob("*.pdf"))
    print(f"   Found {len(all_pdfs)} PDFs in all subfolders\n")

    if not all_pdfs:
        print("   No PDFs found. Check the folder path.")
        return 0, 0, 0, 0

    tracker = load_tracker()
    collection = get_collection(collection_name)
    total = skipped = failed = reingested = 0
    failed_files = []

    # Count tier distribution
    if folder_tier is not None:
        tier1_count = len(all_pdfs) if folder_tier == 1 else 0
        tier2_count = len(all_pdfs) if folder_tier == 2 else 0
    else:
        tier1_count = sum(1 for p in all_pdfs if get_source_tier(p) == 1)
        tier2_count = len(all_pdfs) - tier1_count
    print(f"   📊 Tier distribution: {tier1_count} tier-1 (Sant Rampal Ji), {tier2_count} tier-2 (scriptures)\n")

    for i, pdf_path in enumerate(
        tqdm(all_pdfs, desc="Processing PDFs")
    ):
        key = str(pdf_path)
        if key in tracker["pdfs"] and not force:
            skipped += 1
            continue
        elif force and key in tracker["pdfs"]:
            rel = str(pdf_path.relative_to(folder))
            try:
                collection.delete(where={"source": f"PDF: {rel}"})
                print(f"\n   🗑️  Deleted existing chunks for {pdf_path.name}")
            except Exception as e:
                print(f"\n   ⚠️ Could not delete existing chunks: {e}")
            tracker["pdfs"].remove(key)
            reingested += 1

        try:
            tier = folder_tier if folder_tier is not None else get_source_tier(pdf_path)
            full_text, page_count = extract_and_clean_pdf(pdf_path, ocr=ocr)
            if len(full_text.strip()) < MIN_CHUNK:
                tracker["pdfs"].append(key)
                save_tracker(tracker)
                continue
            rel = str(pdf_path.relative_to(folder))
            chunks = chunk_text_smart(
                full_text,
                f"PDF: {rel}",
                source_type="pdf",
                source_tier=tier
            )
            added = store_chunks(collection, chunks)
            total += added
            tracker["pdfs"].append(key)
            save_tracker(tracker)
            tier_label = "T1 ★" if tier == 1 else "T2"
            print(f"\n   📄 [{tier_label}] {pdf_path.name} | Pages: {page_count} | Chunks: {len(chunks)} (New: {added})")
            if (i + 1) % 10 == 0:
                print(f"\n   ✅ {i+1}/{len(all_pdfs)} done"
                      f" — {total} chunks so far")
        except Exception as e:
            failed += 1
            error_msg = str(e)
            failed_files.append((str(pdf_path), error_msg))
            log_failure(pdf_path, error_msg)
            print(f"\n   ❌ Failed: {pdf_path.name} — {error_msg}")
            continue

        # ── End-of-run summary ──
    succeeded = len(all_pdfs) - skipped - failed
    print(f"\n{'═' * 50}")
    print(f"   📊 PDF INGESTION SUMMARY")
    print(f"{'═' * 50}")
    print(f"   ✅ Processed successfully: {succeeded}")
    if reingested > 0:
        print(f"   🔄 Re-ingested (--force): {reingested}")
    print(f"   ⏭️  Skipped (already done): {skipped}")
    print(f"   ❌ Failed: {failed}")
    print(f"   💾 New chunks added: {total}")

    if failed_files:
        print(f"\n   ❌ FAILED FILES ({failed}):")
        for fpath, err in failed_files:
            print(f"      • {fpath}")
            print(f"        Error: {err}")
        print(f"\n   📝 Full failure log: {FAILED_LOG}")

    return total, skipped, failed, succeeded

# ════════════════════════════════════════
# DESKTOP BATCH INGESTION
# ════════════════════════════════════════
def batch_ingest_desktop(collection_name=None, force=False, ocr=False):
    import os
    print(f"\n🖥️  DESKTOP BATCH INGESTION")
    desktop = Path.home() / "Desktop"
    if not desktop.exists():
        print(f"❌ Desktop path not found: {desktop}")
        return 0

    ignore_dirs = {'.git', '.venv', 'venv', 'node_modules', 'chroma_db.nosync', '.gemini', 'logs', 'dist', 'build', '.next', 'tatva'}
    folders_to_ingest = []
    
    def count_pdfs(dir_path):
        count = 0
        try:
            for entry in os.scandir(dir_path):
                if entry.is_file() and entry.name.lower().endswith('.pdf'):
                    count += 1
                elif entry.is_dir() and not entry.name.startswith('.') and entry.name not in ignore_dirs:
                    count += count_pdfs(entry.path)
        except Exception:
            pass
        return count

    try:
        for entry in os.scandir(desktop):
            if entry.is_dir() and not entry.name.startswith('.') and entry.name not in ignore_dirs:
                pdf_count = count_pdfs(entry.path)
                if pdf_count > 0:
                    folders_to_ingest.append((entry.name, Path(entry.path), pdf_count))
    except Exception as e:
        print(f"❌ Error scanning Desktop: {e}")
        return 0

    folders_to_ingest.sort(key=lambda x: x[0])
    if not folders_to_ingest:
        print("❌ No folders containing PDF files found on your Desktop.")
        return 0

    print("\n   Found the following folders on Desktop containing PDFs:")
    print("   " + "─" * 65)
    for idx, (name, path, count) in enumerate(folders_to_ingest):
        print(f"    [{idx + 1}] {repr(name):30s} | PDFs: {count:2d} | Path: {path}")
    print("   " + "─" * 65)

    print("\n   [Tier mapping rules]:")
    print("   - Tier 1: Sant Rampal Ji authoritative sources")
    print("   - Tier 2: Secondary scriptures/materials (Upanishads, Puranas, etc.)")
    
    tier_mapping = {}
    print("\n📝 Please map folders to Tiers (Enter '1' or '2' for each, or press Enter for default Tier 2):")
    for name, path, count in folders_to_ingest:
        try:
            choice = input(f"   Tier for folder {repr(name)} (default: 2): ").strip()
            if choice == '1':
                tier_mapping[name] = 1
            else:
                tier_mapping[name] = 2
        except (KeyboardInterrupt, EOFError):
            print("\n⚠️ Input interrupted. Defaulting all remaining to Tier 2.")
            tier_mapping[name] = 2

    # Print final confirmation
    print("\n   Selected Tier mapping:")
    for name, tier in tier_mapping.items():
        print(f"    - {repr(name)} -> Tier {tier}")
        
    try:
        confirm = input("\n👉 Proceed with ingestion? (y/N): ").strip().lower()
        if confirm != 'y':
            print("❌ Ingestion cancelled.")
            return 0
    except (KeyboardInterrupt, EOFError):
        print("\n❌ Ingestion cancelled.")
        return 0

    report = []
    total_added_all = 0
    
    for name, path, count in folders_to_ingest:
        tier = tier_mapping[name]
        print(f"\n{'═' * 60}")
        print(f"📂 Batch Ingesting: {repr(name)} (Tier {tier})")
        print(f"{'═' * 60}")
        
        added, skipped, failed, succeeded = ingest_pdfs(
            path, 
            collection_name=collection_name, 
            force=force, 
            ocr=ocr, 
            folder_tier=tier
        )
        
        report.append({
            "folder": name,
            "count": count,
            "succeeded": succeeded,
            "skipped": skipped,
            "failed": failed,
            "added_chunks": added,
            "tier": tier
        })
        total_added_all += added

    # Consolidated report
    print(f"\n{'═' * 70}")
    print(f"📊 CONSOLIDATED DESKTOP BATCH INGESTION SUMMARY")
    print(f"{'═' * 70}")
    
    # Table header
    print(f" {'Folder Name':25s} | {'Tier':4s} | {'PDFs':4s} | {'OK':3s} | {'Skip':4s} | {'Fail':4s} | {'Chunks':6s}")
    print(" " + "─" * 68)
    
    for r in report:
        print(f" {repr(r['folder'])[:25]:25s} | T{r['tier']}   | {r['count']:4d} | {r['succeeded']:3d} | {r['skipped']:4d} | {r['failed']:4d} | {r['added_chunks']:6d}")
        
    print(" " + "─" * 68)
    print(f" {'TOTAL':25s} |      | {sum(r['count'] for r in report):4d} | {sum(r['succeeded'] for r in report):3d} | {sum(r['skipped'] for r in report):4d} | {sum(r['failed'] for r in report):4d} | {total_added_all:6d}")
    print(f"{'═' * 70}\n")
    
    return total_added_all

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

def ingest_youtube(url, collection_name=None):
    print(f"\n🎬 YOUTUBE INGESTION")
    print(f"   Source: {url}")
    print("─" * 50)
    tracker = load_tracker()
    collection = get_collection(collection_name)
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
        chunks = chunk_text_smart(text, src, source_type="youtube", source_tier=2)
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

def ingest_website(base_url, collection_name=None):
    print(f"\n🌐 WEBSITE INGESTION")
    print(f"   Source: {base_url}")
    print(f"   Crawling up to {MAX_WEB_PAGES} pages")
    print("─" * 50)
    tracker = load_tracker()
    collection = get_collection(collection_name)
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
                text, f"Website: {url}", source_type="web_page", source_tier=2
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
def show_stats(collection_name=None):
    try:
        col = get_collection(collection_name)
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
        coll_display = collection_name or COLLECTION
        print(f"""
╔══════════════════════════════════════╗
║     TATVA KNOWLEDGE BASE STATS       ║
╠══════════════════════════════════════╣
║  Collection    : {str(coll_display).ljust(18)} ║
║  Embed Model   : multilingual-L12    ║
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
╔══════════════════════════════════════════════════════════════╗
║      Tatva AI — Knowledge Ingestion (v2 Multilingual)       ║
╠══════════════════════════════════════════════════════════════╣
║  pdf   /path/to/folder  — ingest all PDFs (recursive)       ║
║  desktop                — scan & batch-ingest ~/Desktop/   ║
║  yt    https://youtube  — channel/playlist                  ║
║  web   https://site.com — entire website                    ║
║  stats                  — show DB stats                     ║
║  reset                  — clear tracker                     ║
║                                                             ║
║  Options:                                                   ║
║    --collection NAME    — target collection (default: v2)   ║
║    --workers N          — parallel workers (default: 1)     ║
║    --force              — re-ingest skipped PDFs            ║
║    --ocr                — use OCR (requires tesseract)      ║
╚══════════════════════════════════════════════════════════════╝
    """)

def parse_args(argv):
    """Parse --collection, --workers, --force, --ocr from argv."""
    collection = None
    workers = 1  # default 1 on macOS to avoid segfaults
    force = False
    ocr = False
    remaining = []
    i = 0
    while i < len(argv):
        if argv[i] == '--collection' and i + 1 < len(argv):
            collection = argv[i + 1]
            i += 2
        elif argv[i] == '--workers' and i + 1 < len(argv):
            workers = int(argv[i + 1])
            i += 2
        elif argv[i] == '--force':
            force = True
            i += 1
        elif argv[i] == '--ocr':
            ocr = True
            i += 1
        else:
            remaining.append(argv[i])
            i += 1
    return remaining, collection, workers, force, ocr

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print_usage()
        sys.exit(0)

    args, collection_override, workers, force, ocr = parse_args(sys.argv[1:])

    if not args:
        print_usage()
        sys.exit(0)

    cmd = args[0].lower()
    total = 0

    if cmd == "pdf":
        if len(args) < 2:
            print("Usage: python3 ingest_all.py pdf /path/")
            sys.exit(1)
        full_path = " ".join(args[1:])
        total, _, _, _ = ingest_pdfs(full_path, collection_name=collection_override, force=force, ocr=ocr)

    elif cmd == "desktop":
        total = batch_ingest_desktop(collection_name=collection_override, force=force, ocr=ocr)

    elif cmd == "yt":
        if len(args) < 2:
            print("Usage: python3 ingest_all.py yt URL")
            sys.exit(1)
        total = ingest_youtube(args[1], collection_name=collection_override)

    elif cmd == "web":
        if len(args) < 2:
            print("Usage: python3 ingest_all.py web URL")
            sys.exit(1)
        total = ingest_website(args[1], collection_name=collection_override)

    elif cmd == "stats":
        show_stats(collection_name=collection_override)
        sys.exit(0)

    elif cmd == "reset":
        reset_database()
        sys.exit(0)

    else:
        print(f"❌ Unknown: {cmd}")
        print_usage()
        sys.exit(1)

    show_stats(collection_name=collection_override)
    print(f"\n✅ Done. New chunks this session: {total}\n")
