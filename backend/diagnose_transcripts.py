#!/usr/bin/env python3
"""
Diagnostic script to test youtube-transcript-api on the top 5 video IDs.
"""

import sys
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound

video_ids = [
    "vujLxpA9DqU",
    "kG8yyKsp5m8",
    "dST4iENcsjQ",
    "cTOefvlVPbs",
    "YRbf9-NBHzI"
]

print("=== STARTING YOUTUBE TRANSCRIPT DIAGNOSTIC ===")
for vid in video_ids:
    print(f"\n🎥 Checking Video ID: {vid}")
    try:
        if hasattr(YouTubeTranscriptApi, 'list_transcripts'):
            tlist = YouTubeTranscriptApi.list_transcripts(vid)
        else:
            tlist = YouTubeTranscriptApi().list(vid)
            
        print("   Found transcripts list:")
        for t in tlist:
            print(f"      • Language Code: {t.language_code}")
            print(f"        Language Name: {t.language}")
            print(f"        Is Generated : {t.is_generated}")
            print(f"        Is Translatable: {t.is_translatable}")
            
            # Test fetch
            try:
                data = t.fetch()
                print(f"        Fetch success! Total segments: {len(data)}")
                if data:
                    first_seg = data[0]
                    print(f"        First segment type: {type(first_seg)}")
                    print(f"        First segment representation: {repr(first_seg)}")
                    print(f"        First segment hasattr('text'): {hasattr(first_seg, 'text')}")
                    print(f"        First segment text value: {getattr(first_seg, 'text', 'N/A')}")
                    # Sample Hindi
                    sample_text = " ".join([getattr(s, 'text', '') for s in data[:5]])
                    print(f"        Sample text: {sample_text}")
            except Exception as fe:
                print(f"        ❌ Fetch failed: {fe}")
    except TranscriptsDisabled:
        print("   ❌ TranscriptsDisabled: Transcripts are disabled for this video.")
    except NoTranscriptFound:
        print("   ❌ NoTranscriptFound: No transcript was found for this video.")
    except Exception as e:
        print(f"   ❌ Exception of type {type(e).__name__}: {e}")

print("\n=== DIAGNOSTIC COMPLETE ===")
