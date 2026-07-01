#!/usr/bin/env python3
"""
Tatva AI — YouTube Channel Ingestion Pipeline
==============================================
This script fetches the video metadata for all uploads of a YouTube channel,
downloads the word-for-word spoken transcripts, performs smart sentence/timestamp chunking,
and stores them in ChromaDB with proper metadata and tiering.

Usage:
  python3 ingest_yt_pipeline.py --api-key YOUR_KEY [--limit 20] [--dry-run]
"""

import sys
import os
import re
import time
import json
import hashlib
import argparse
from pathlib import Path

# ─── macOS SAFETY: set spawn before any torch/model imports ───
import multiprocessing
if sys.platform == "darwin":
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass  # already set

import torch
from sentence_transformers import SentenceTransformer
import chromadb
from chromadb.api.types import EmbeddingFunction, Documents, Embeddings
import yt_dlp
import requests
import xml.etree.ElementTree as ET
import html
from tqdm import tqdm

# ─── PATHS & CONFIG ──────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent
CHROMA_PATH = BACKEND_DIR / "chroma_db.nosync"
COLLECTION_NAME = "tatva_knowledge"

VIDEO_CACHE_FILE = BACKEND_DIR / "yt_channel_videos.json"
INGEST_TRACKER_FILE = BACKEND_DIR / "yt_ingest_tracker.json"
FAILED_LOG = BACKEND_DIR / "yt_failed_transcripts.log"

CHUNK_SIZE = 1200     # ~300 tokens
CHUNK_OVERLAP = 200  # overlap context
MIN_CHUNK = 50       # minimum characters to keep

# Device auto-detection
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"
else:
    DEVICE = "cpu"

# ─── EMBEDDING MODEL & CHROME COMPATIBLE EMBEDDER ───
EMBED_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
embed_model = None

def get_embed_model():
    global embed_model
    if embed_model is None:
        print(f"[Ingest] Loading embedding model: {EMBED_MODEL_NAME} on device: {DEVICE}...")
        embed_model = SentenceTransformer(EMBED_MODEL_NAME, device=DEVICE)
        print(f"[Ingest] Model loaded successfully. Dimension: {embed_model.get_sentence_embedding_dimension()}")
    return embed_model

class MultilingualEmbedder(EmbeddingFunction):
    """ChromaDB-compatible embedding function using the multilingual model."""
    def __call__(self, input: Documents) -> Embeddings:
        model = get_embed_model()
        embeddings = model.encode(
            input,
            normalize_embeddings=True,
            show_progress_bar=False
        )
        return embeddings.tolist()

    def name(self) -> str:
        return "sentence_transformer"

multilingual_embedder = MultilingualEmbedder()

# ─── LOGGING & METRICS HELPERS ────────────────
def log_failure(video_id, title, reason):
    with open(FAILED_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Video {video_id} | Title: {title} | Reason: {reason}\n")

def make_id(text):
    return hashlib.md5(text.encode("utf-8", errors="ignore")).hexdigest()

# ─── STEP 1: RESOLVE CHANNEL & FETCH MASTER VIDEO LIST ───
def resolve_channel_details(handle, api_key):
    """Resolve a YouTube channel handle to Channel ID and Uploads Playlist ID."""
    import requests
    
    clean_handle = handle.strip().split('/')[-1]
    if not clean_handle.startswith('@'):
        clean_handle = '@' + clean_handle
        
    print(f"\n🔍 Resolving channel handle: {clean_handle}")
    
    # 1. Try resolving using handle endpoint
    url = f"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle={clean_handle}&key={api_key}"
    try:
        r = requests.get(url)
        data = r.json()
        if 'items' in data and len(data['items']) > 0:
            channel_id = data['items'][0]['id']
            uploads_playlist = data['items'][0]['contentDetails']['relatedPlaylists']['uploads']
            print(f"   ✅ Resolved via Handle API: Channel ID={channel_id} | Uploads Playlist={uploads_playlist}")
            return channel_id, uploads_playlist
    except Exception as e:
        print(f"   ⚠️ Handle resolution call failed: {e}")
        
    # 2. Try resolving via search fallback
    url_search = f"https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q={clean_handle}&key={api_key}"
    try:
        r = requests.get(url_search)
        data = r.json()
        if 'items' in data and len(data['items']) > 0:
            channel_id = data['items'][0]['snippet']['channelId']
            
            # Fetch uploads details using channel ID
            url_details = f"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id={channel_id}&key={api_key}"
            r_details = requests.get(url_details)
            data_details = r_details.json()
            if 'items' in data_details and len(data_details['items']) > 0:
                uploads_playlist = data_details['items'][0]['contentDetails']['relatedPlaylists']['uploads']
                print(f"   ✅ Resolved via Search Fallback: Channel ID={channel_id} | Uploads Playlist={uploads_playlist}")
                return channel_id, uploads_playlist
    except Exception as e:
        print(f"   ⚠️ Search fallback failed: {e}")
        
    # Hardcoded fallback for the target channel if resolution fails
    if "SaintRampalJiMaharaj" in handle:
        print("   ℹ️ Using fallback static details for @SaintRampalJiMaharaj")
        return "UCxFzLzY6a02V0E5K5R05aEw", "UUxFzLzY6a02V0E5K5R05aEw"
        
    return None, None

def update_video_metadata_cache(playlist_id, api_key):
    """Load cached video metadata and incrementally append newly fetched videos."""
    import requests
    
    cached_videos = []
    cached_ids = set()
    
    if VIDEO_CACHE_FILE.exists():
        try:
            with open(VIDEO_CACHE_FILE, 'r', encoding='utf-8') as f:
                cached_videos = json.load(f)
                cached_ids = {v['video_id'] for v in cached_videos}
            print(f"   ℹ️ Loaded {len(cached_videos)} cached videos from local master list")
        except Exception as e:
            print(f"   ⚠️ Could not load cached videos: {e}")

    new_videos = []
    next_page_token = None
    url = "https://www.googleapis.com/youtube/v3/playlistItems"
    duplicate_found = False
    
    print(f"   📡 Checking YouTube Data API for new uploads...")
    while not duplicate_found:
        params = {
            "part": "snippet",
            "playlistId": playlist_id,
            "maxResults": 50,
            "key": api_key
        }
        if next_page_token:
            params["pageToken"] = next_page_token
            
        try:
            r = requests.get(url, params=params)
            data = r.json()
            if 'error' in data:
                print(f"   ❌ YouTube Data API Error: {data['error']['message']}")
                break
                
            items = data.get('items', [])
            if not items:
                break
                
            for item in items:
                snippet = item.get('snippet', {})
                video_id = snippet.get('resourceId', {}).get('videoId')
                title = snippet.get('title', '')
                published_at = snippet.get('publishedAt', '')
                
                if video_id:
                    if video_id in cached_ids:
                        duplicate_found = True
                        break
                    new_videos.append({
                        "video_id": video_id,
                        "title": title,
                        "published_at": published_at
                    })
            
            print(f"   Fetched {len(new_videos)} new video details from API...")
            next_page_token = data.get('nextPageToken')
            if not next_page_token or duplicate_found:
                break
        except Exception as e:
            print(f"   ❌ Network error during video fetch: {e}")
            break
            
    if new_videos:
        print(f"   ✨ Found {len(new_videos)} new uploads since last sync!")
        combined_videos = new_videos + cached_videos
        try:
            with open(VIDEO_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(combined_videos, f, ensure_ascii=False, indent=2)
            print(f"   💾 Updated master cache to {len(combined_videos)} videos.")
        except Exception as e:
            print(f"   ❌ Could not save master video list cache: {e}")
    else:
        print("   ✅ Master video list is already up to date!")
        combined_videos = cached_videos
        
    return combined_videos

# ─── STEP 2: TRANSCRIPT FETCHING WITH AUTO-GENERATION CLASSIFICATION ───
def parse_vtt(vtt_text):
    lines = vtt_text.splitlines()
    segments = []
    current_time = None
    text_lines = []
    
    time_re = re.compile(r'(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})')
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if "-->" in line:
            if current_time and text_lines:
                segments.append({
                    "text": " ".join(text_lines),
                    "start": current_time["start"],
                    "duration": max(0.1, current_time["end"] - current_time["start"])
                })
                text_lines = []
            
            match = time_re.match(line)
            if match:
                sh, sm, ss, sms, eh, em, es, ems = map(int, match.groups())
                start_sec = sh * 3600 + sm * 60 + ss + sms / 1000.0
                end_sec = eh * 3600 + em * 60 + es + ems / 1000.0
                current_time = {"start": start_sec, "end": end_sec}
        elif current_time:
            clean_line = re.sub(r'<[^>]+>', '', line).strip()
            if clean_line and not any(clean_line.startswith(x) for x in ["WEBVTT", "Kind:", "Language:", "Style:", "Position:"]):
                text_lines.append(clean_line)
                
    if current_time and text_lines:
        segments.append({
            "text": " ".join(text_lines),
            "start": current_time["start"],
            "duration": max(0.1, current_time["end"] - current_time["start"])
        })
        
    return segments

def parse_srv(xml_text):
    try:
        root = ET.fromstring(xml_text)
        segments = []
        for child in root.findall('text'):
            start = float(child.attrib.get('start', 0.0))
            duration = float(child.attrib.get('dur', 0.0))
            text = html.unescape(child.text or "").strip()
            text = re.sub(r'\s+', ' ', text)
            if text:
                segments.append({
                    "text": text,
                    "start": start,
                    "duration": duration
                })
        return segments
    except Exception as e:
        print(f"   ⚠️ XML Parsing failed: {e}")
        return []

def get_video_transcript(video_id):
    """Fetch transcripts using yt-dlp to extract details, then parse XML/VTT subtitles in-memory.
    Supports proxy, retries with exponential backoff on IP blocks.
    Returns (transcript_data, transcript_type, language_code) or (None, error_or_skip_reason, None).
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    proxy = os.getenv("YT_PROXY")
    
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
    }
    if proxy:
        ydl_opts['proxy'] = proxy
        
    # Retry intervals for exponential backoff on rate-limit/blocking:
    # Attempt 0: instant
    # Attempt 1: wait 60s
    # Attempt 2: wait 300s (5m)
    # Attempt 3: wait 1800s (30m)
    backoff_intervals = [0, 60, 300, 1800]
    
    for attempt, wait_time in enumerate(backoff_intervals):
        if wait_time > 0:
            print(f"   ⚠️ Rate limited or blocked. Retrying after backoff of {wait_time}s (Attempt {attempt}/{len(backoff_intervals)-1})...")
            time.sleep(wait_time)
            
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
            subtitles = info.get('subtitles', {})
            auto_subs = info.get('automatic_captions', {})
            
            target_langs = ['hi', 'sa', 'en']
            selected_track = None
            selected_lang = None
            selected_type = None
            
            # Check manual first
            for lang in target_langs:
                matching_keys = [k for k in subtitles.keys() if k == lang or k.startswith(lang + '-')]
                if matching_keys:
                    selected_track = subtitles[matching_keys[0]]
                    selected_lang = matching_keys[0]
                    selected_type = "manual"
                    break
            
            # Check auto-generated if no manual found
            if not selected_track:
                for lang in target_langs:
                    matching_keys = [k for k in auto_subs.keys() if k == lang or k.startswith(lang + '-')]
                    if matching_keys:
                        selected_track = auto_subs[matching_keys[0]]
                        selected_lang = matching_keys[0]
                        selected_type = "auto-generated"
                        break
                        
            if not selected_track:
                return None, "no_matching_transcript", None
                
            prefer_exts = ['srv1', 'srv3', 'vtt']
            chosen_format = None
            for ext in prefer_exts:
                formats = [f for f in selected_track if f.get('ext') == ext]
                if formats:
                    chosen_format = formats[0]
                    break
            if not chosen_format:
                chosen_format = selected_track[0]
                
            sub_url = chosen_format.get('url')
            sub_ext = chosen_format.get('ext')
            
            if not sub_url:
                return None, "no_subtitle_url", None
                
            req_opts = {"timeout": 15}
            if proxy:
                req_opts["proxies"] = {"http": proxy, "https": proxy}
                
            resp = requests.get(sub_url, **req_opts)
            if resp.status_code == 429:
                raise Exception("HTTP 429: Rate limited/Too Many Requests")
            if resp.status_code != 200:
                raise Exception(f"HTTP {resp.status_code}: Failed to fetch subtitle file")
                
            content = resp.text
            if not content.strip():
                return None, "empty_subtitle_file", None
                
            if sub_ext in ['srv1', 'srv3'] or content.strip().startswith('<?xml') or '<transcript>' in content:
                data = parse_srv(content)
            else:
                data = parse_vtt(content)
                
            if not data:
                return None, "failed_to_parse_subtitle_data", None
                
            # Log debug output
            print(f"   [DEBUG] Transcript fetched for {video_id} ({selected_type}):")
            print(f"      - Language: {selected_lang} (Format: {sub_ext})")
            print(f"      - Total segments: {len(data)}")
            preview_text = " ".join([s['text'] for s in data[:5]])
            print(f"      - Extracted preview (first 5 segments): {preview_text[:200]}")
            
            return data, selected_type, selected_lang
            
        except Exception as e:
            err_msg = str(e)
            is_block = "429" in err_msg or "Blocked" in err_msg or "confirm you’re not a bot" in err_msg or "403" in err_msg
            
            if attempt == len(backoff_intervals) - 1 or not is_block:
                import traceback
                full_err = f"error: {type(e).__name__}: {err_msg}\n{traceback.format_exc()}"
                return None, full_err, None
                
            continue
            
    return None, "rate_limit_max_retries_exceeded", None

# ─── STEP 3: SMART SENTENCE & TIMESTAMP CHUNKING ───
def chunk_transcript_with_timestamps(transcript_data, max_chars=CHUNK_SIZE, min_chars=150, overlap_chars=CHUNK_OVERLAP):
    """Group transcript segments, keeping boundaries aligned to sentences where possible.
    If no punctuation is found, groups segments by time boundaries.
    """
    # Normalize segment dictionaries / objects to dicts for backward & forward compatibility
    normalized_data = []
    for seg in transcript_data:
        if isinstance(seg, dict):
            normalized_data.append(seg)
        else:
            normalized_data.append({
                "text": getattr(seg, "text", ""),
                "start": getattr(seg, "start", 0.0),
                "duration": getattr(seg, "duration", 0.0)
            })
    transcript_data = normalized_data

    chunks = []
    current_segments = []
    current_len = 0
    
    for seg in transcript_data:
        text = seg['text'].strip()
        if not text:
            continue
            
        current_segments.append(seg)
        current_len += len(text) + 1  # +1 for separating space
        
        if current_len >= max_chars:
            # Look backwards for a sentence ending to split on
            split_idx = -1
            accumulated_len = 0
            for idx, s in enumerate(current_segments):
                accumulated_len += len(s['text']) + 1
                if accumulated_len >= min_chars:
                    if re.search(r'[.!?।॥]$', s['text'].strip()):
                        split_idx = idx
            
            if split_idx != -1:
                chunk_segs = current_segments[:split_idx + 1]
                remaining_segs = current_segments[split_idx + 1:]
            else:
                # Fallback: slice before the last item to prevent overflow
                if len(current_segments) > 1:
                    chunk_segs = current_segments[:-1]
                    remaining_segs = [current_segments[-1]]
                else:
                    chunk_segs = current_segments
                    remaining_segs = []
            
            if chunk_segs:
                chunk_text = " ".join([s['text'] for s in chunk_segs]).strip()
                chunk_text = re.sub(r'\s+', ' ', chunk_text)
                
                if len(chunk_text) >= min_chars:
                    start_time = int(chunk_segs[0]['start'])
                    end_time = int(chunk_segs[-1]['start'] + chunk_segs[-1]['duration'])
                    chunks.append({
                        "text": chunk_text,
                        "start_sec": start_time,
                        "end_sec": end_time
                    })
            
            # Form overlapping segments
            overlap_segs = []
            overlap_len = 0
            for s in reversed(chunk_segs):
                if overlap_len + len(s['text']) <= overlap_chars:
                    overlap_segs.insert(0, s)
                    overlap_len += len(s['text']) + 1
                else:
                    break
                    
            current_segments = overlap_segs + remaining_segs
            current_len = sum(len(s['text']) + 1 for s in current_segments)
            
    # Add trailing segment remaining
    if current_segments:
        chunk_text = " ".join([s['text'] for s in current_segments]).strip()
        chunk_text = re.sub(r'\s+', ' ', chunk_text)
        if len(chunk_text) >= min_chars or (chunks == [] and len(chunk_text) >= MIN_CHUNK):
            start_time = int(current_segments[0]['start'])
            end_time = int(current_segments[-1]['start'] + current_segments[-1]['duration'])
            chunks.append({
                "text": chunk_text,
                "start_sec": start_time,
                "end_sec": end_time
            })
            
    return chunks

# ─── STEP 4: METADATA & EPISODE PARSING ───
def extract_episode_num(title):
    """Extract episode digits from Satsang episode titles."""
    # Match patterns like: Episode: 3608, Episode-3608, Ep 3608, Ep-3608, एपिसोड 3608, अंक 12
    patterns = [
        r'(?:episode|ep|एपिसोड|अंक)\s*[:\-#]?\s*(\d+)',
        r'[:\-#]\s*(\d+)\b'
    ]
    for pattern in patterns:
        match = re.search(pattern, title, re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None

# ─── STEP 5: CHROMADB STORAGE & INTEGRITY ───
def get_chroma_collection(collection_name):
    # HttpClient fallback logic identical to ingest_all.py
    name = collection_name or COLLECTION_NAME
    try:
        import requests
        resp = requests.get("http://localhost:8000/api/v2/heartbeat", timeout=2)
        if resp.status_code == 200:
            print("🔗 Connecting to running ChromaDB server via HttpClient (localhost:8000)...")
            client = chromadb.HttpClient(host="localhost", port=8000)
        else:
            raise Exception("Heartbeat failed")
    except Exception:
        print(f"📁 Connecting directly to ChromaDB PersistentClient (path: {CHROMA_PATH.resolve()})...")
        client = chromadb.PersistentClient(path=str(CHROMA_PATH))

    collection = client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
        embedding_function=multilingual_embedder
    )
    return collection

def load_ingested_tracker():
    if INGEST_TRACKER_FILE.exists():
        try:
            with open(INGEST_TRACKER_FILE, 'r') as f:
                data = json.load(f)
                return set(data.get("ingested_video_ids", []))
        except Exception as e:
            print(f"⚠️ Could not load ingestion tracker: {e}")
    return set()

def save_ingested_tracker(ingested_set):
    try:
        with open(INGEST_TRACKER_FILE, 'w') as f:
            json.dump({"ingested_video_ids": list(ingested_set)}, f, indent=2)
    except Exception as e:
        print(f"⚠️ Could not save ingestion tracker: {e}")

# ─── STEP 6: EXECUTION & PROGRESS CONTROLLER ───
def process_channel_ingestion(api_key, collection_name=None, limit=None, dry_run=False):
    channel_handle = "https://www.youtube.com/@SaintRampalJiMaharaj"
    
    # 1. Sync list
    channel_id, uploads_playlist = resolve_channel_details(channel_handle, api_key)
    if not uploads_playlist:
        print("❌ Could not resolve uploads playlist. Exiting.")
        return
        
    videos = update_video_metadata_cache(uploads_playlist, api_key)
    if not videos:
        print("❌ No videos to ingest. Exiting.")
        return
        
    ingested_ids = load_ingested_tracker()
    
    # Filter pending videos
    pending_videos = [v for v in videos if v['video_id'] not in ingested_ids]
    print(f"\n📊 Queue Status:")
    print(f"   • Total videos in master list : {len(videos)}")
    print(f"   • Already ingested            : {len(ingested_ids)}")
    print(f"   • Pending Ingestion           : {len(pending_videos)}")
    
    if not pending_videos:
        print("🎉 All videos are already fully ingested!")
        return

    if limit:
        print(f"   ⚙️  Applying limit: Processing top {limit} videos.")
        pending_videos = pending_videos[:limit]

    if dry_run:
        print("\n🔍 DRY-RUN MODE: Checking transcript availability...")
        available = 0
        for v in tqdm(pending_videos, desc="Dry-running videos"):
            data, t_type, lang = get_video_transcript(v['video_id'])
            if data:
                available += 1
        print(f"\n📊 Dry-run Summary:")
        print(f"   • Scanned pending videos     : {len(pending_videos)}")
        print(f"   • Transcripts available      : {available}")
        print(f"   • Transcripts missing/disabled: {len(pending_videos) - available}")
        return

    # Ingestion mode
    collection = get_chroma_collection(collection_name)
    success = skipped = failed = total_chunks = 0
    consecutive_failures = 0
    
    print(f"\n🚀 Ingestion Mode: Initializing embedding generation and database writing...")
    for idx, v in enumerate(pending_videos):
        # Configurable delay between video requests (except the first video)
        if idx > 0:
            print("   ⏳ Sleeping 5.0 seconds between video requests...")
            time.sleep(5.0)
            
        vid_id = v['video_id']
        title = v['title']
        pub_date = v['published_at']
        
        # Fetch transcript
        data, t_type, lang = get_video_transcript(vid_id)
        if data is None:
            # Check if this is a genuine skip or a real failure
            if t_type in ["disabled", "not_found", "no_matching_transcript"]:
                skipped += 1
                log_failure(vid_id, title, f"No transcript available (Reason: {t_type})")
                # Mark as processed with empty to avoid checking it again
                ingested_ids.add(vid_id)
                save_ingested_tracker(ingested_ids)
            else:
                failed += 1
                log_failure(vid_id, title, f"Transcript fetch error: {t_type}")
                print(f"   ❌ Failed to ingest {title} ({vid_id}) — {t_type.splitlines()[0]}")
                
                # Check if error indicates block/rate limit
                is_block = "429" in t_type or "Blocked" in t_type or "confirm you’re not a bot" in t_type or "403" in t_type
                if is_block:
                    consecutive_failures += 1
                    if consecutive_failures >= 3:
                        print(f"\n   🛑 Cooldown Triggered: {consecutive_failures} consecutive rate-limit/blocking failures encountered.")
                        print("      Pausing the pipeline for 60 minutes to let the block cool down...")
                        for min_left in range(60, 0, -5):
                            print(f"      - {min_left} minutes remaining...")
                            time.sleep(300)
                        consecutive_failures = 0  # Reset after cooldown
            continue
            
        try:
            # Chunking
            chunks = chunk_transcript_with_timestamps(data)
            if not chunks:
                skipped += 1
                ingested_ids.add(vid_id)
                save_ingested_tracker(ingested_ids)
                continue
                
            # Parse Episode Number
            ep_num = extract_episode_num(title)
            
            # Map tier: manual -> 1.25, auto-generated -> 1.5
            tier = 1.25 if t_type == "manual" else 1.5
            
            # Prepare ChromaDB elements
            documents = []
            metadatas = []
            ids = []
            
            for chunk_idx, chunk in enumerate(chunks):
                start_sec = chunk['start_sec']
                chunk_text = chunk['text']
                
                # Make ID unique
                chunk_id = make_id(f"{vid_id}_{chunk_idx}_{chunk_text}")
                
                source_url = f"https://youtube.com/watch?v={vid_id}?t={start_sec}s"
                
                meta = {
                    "source": f"YouTube: {source_url}",
                    "video_id": vid_id,
                    "title": title,
                    "upload_date": pub_date[:10] if pub_date else "",
                    "transcript_type": t_type,
                    "source_tier": tier,
                    "type": "youtube"
                }
                if ep_num is not None:
                    meta["episode_num"] = ep_num
                    
                documents.append(chunk_text)
                metadatas.append(meta)
                ids.append(chunk_id)
                
            # Add to ChromaDB
            collection.add(
                documents=documents,
                metadatas=metadatas,
                ids=ids
            )
            
            total_chunks += len(documents)
            success += 1
            consecutive_failures = 0  # Reset consecutive failures on success
            ingested_ids.add(vid_id)
            save_ingested_tracker(ingested_ids)
            
        except Exception as e:
            failed += 1
            log_failure(vid_id, title, f"Ingest execution error: {str(e)}")
            print(f"\n   ❌ Failed to ingest {title} ({vid_id}): {e}")
            continue
            
        # Standard progress logging
        if (idx + 1) % 5 == 0 or idx == 0 or (idx + 1) == len(pending_videos):
            print(f"📈 Progress: Checked {idx+1}/{len(pending_videos)} videos | Ingested: {success} | Skipped: {skipped} | Failed: {failed} | Chunks added: {total_chunks}")
            
    print(f"\n{'═' * 50}")
    print(f"📊 BATCH INGESTION COMPLETE SUMMARY")
    print(f"{'═' * 50}")
    print(f"   ✅ Videos successfully ingested: {success}")
    print(f"   ⏭️  Videos skipped (no transcript): {skipped}")
    print(f"   ❌ Videos failed (logged errors): {failed}")
    print(f"   💾 New chunks added to ChromaDB  : {total_chunks}")
    print(f"{'═' * 50}\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Tatva AI — YouTube Ingestion Pipeline")
    parser.add_argument("--api-key", help="YouTube Data API v3 Key", required=True)
    parser.add_argument("--collection", help="Target ChromaDB Collection", default=COLLECTION_NAME)
    parser.add_argument("--limit", type=int, help="Limit number of videos to ingest")
    parser.add_argument("--dry-run", action="store_true", help="Count transcripts without ingesting")
    
    args = parser.parse_args()
    
    process_channel_ingestion(
        api_key=args.api_key,
        collection_name=args.collection,
        limit=args.limit,
        dry_run=args.dry_run
    )
