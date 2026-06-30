#!/usr/bin/env python3
"""
Tatva AI — QA Bank Ingestion into Dedicated ChromaDB Collection
================================================================
This script reads the curated Q&A pairs from qa_data.txt and ingests them
into a SEPARATE ChromaDB collection ('tatva_qa') with proper metadata.

Each Q&A pair is stored as a single document: "Q: ... A: ..."
This allows the retrieval pipeline to do a precision lookup against
verified answers FIRST before falling back to general KB chunks.

Usage:
  python3 ingest_qa.py
"""

import re
import hashlib
import chromadb
from pathlib import Path

CHROMA_PATH = Path(__file__).parent / "chroma_db"
QA_FILE = Path(__file__).parent / "scratch" / "qa_data.txt"
QA_COLLECTION = "tatva_qa"       # Dedicated QA collection
KB_COLLECTION = "tatva_knowledge"  # Also add to main KB with type='qa'

def make_id(text):
    return hashlib.md5(text.encode("utf-8", errors="ignore")).hexdigest()

def parse_qa_pairs(filepath):
    """Parse the Q&A data file into structured pairs."""
    text = filepath.read_text(encoding="utf-8")
    
    # Pattern: number followed by period, question, then answer on next line(s)
    # Handle both "N. Question?\nAnswer" and "N. Question\nAnswer" formats
    lines = text.split('\n')
    
    pairs = []
    current_q = None
    current_a_lines = []
    current_num = None
    
    for line in lines:
        line = line.strip()
        if not line:
            # Empty line might separate sections
            if current_q and current_a_lines:
                pairs.append({
                    'num': current_num,
                    'question': current_q,
                    'answer': ' '.join(current_a_lines).strip()
                })
                current_q = None
                current_a_lines = []
                current_num = None
            continue
        
        # Check if this is a "Part N:" section header
        if re.match(r'^Part\s+\d+', line, re.IGNORECASE):
            if current_q and current_a_lines:
                pairs.append({
                    'num': current_num,
                    'question': current_q,
                    'answer': ' '.join(current_a_lines).strip()
                })
                current_q = None
                current_a_lines = []
                current_num = None
            continue
        
        # Check if this is a numbered question line
        q_match = re.match(r'^(\d+)\.\s+(.+)', line)
        if q_match:
            # Save previous pair
            if current_q and current_a_lines:
                pairs.append({
                    'num': current_num,
                    'question': current_q,
                    'answer': ' '.join(current_a_lines).strip()
                })
            
            current_num = int(q_match.group(1))
            rest = q_match.group(2).strip()
            
            # Check if the line contains both Q and A (question ends with ?)
            q_end = rest.find('?')
            if q_end != -1 and q_end < len(rest) - 1:
                # Question and answer on same line
                current_q = rest[:q_end+1].strip()
                current_a_lines = [rest[q_end+1:].strip()]
            else:
                current_q = rest
                current_a_lines = []
        else:
            # This is a continuation/answer line
            if current_q is not None:
                current_a_lines.append(line)
    
    # Don't forget the last pair
    if current_q and current_a_lines:
        pairs.append({
            'num': current_num,
            'question': current_q,
            'answer': ' '.join(current_a_lines).strip()
        })
    
    return pairs

def ingest_qa():
    if not QA_FILE.exists():
        print(f"❌ QA file not found: {QA_FILE}")
        return
    
    print(f"📖 Parsing QA pairs from: {QA_FILE}")
    pairs = parse_qa_pairs(QA_FILE)
    print(f"   Found {len(pairs)} Q&A pairs")
    
    if not pairs:
        print("❌ No Q&A pairs found!")
        return
    
    # Show samples
    for p in pairs[:3]:
        print(f"\n   Q{p['num']}: {p['question'][:80]}...")
        print(f"   A: {p['answer'][:80]}...")
    
    # Connect to ChromaDB
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    
    # Create dedicated QA collection
    qa_col = client.get_or_create_collection(
        name=QA_COLLECTION,
        metadata={"hnsw:space": "cosine"}
    )
    
    # Also get main KB collection
    kb_col = client.get_or_create_collection(
        name=KB_COLLECTION,
        metadata={"hnsw:space": "cosine"}
    )
    
    print(f"\n💾 Ingesting into '{QA_COLLECTION}' (dedicated) and '{KB_COLLECTION}' (main KB)...")
    
    # Prepare documents
    qa_docs = []
    qa_ids = []
    qa_metas = []
    
    kb_docs = []
    kb_ids = []
    kb_metas = []
    
    for idx, p in enumerate(pairs):
        # Format: Combined Q&A for better semantic matching
        doc_text = f"Question: {p['question']}\nAnswer: {p['answer']}"
        
        # Use sequential index in ID to avoid duplicate collisions
        qa_id = f"qa_{idx:04d}_{p['num']}"
        kb_id = f"qa_kb_{idx:04d}_{p['num']}"
        
        # For QA collection - store as full Q&A pair
        qa_docs.append(doc_text)
        qa_ids.append(qa_id)
        qa_metas.append({
            "source": f"Verified Q&A Bank #{p['num']}",
            "type": "qa",
            "question": p['question'][:500],  # Store question separately for matching
            "qa_num": str(p['num'])
        })
        
        # For main KB collection - also add with type='qa'
        kb_docs.append(doc_text)
        kb_ids.append(kb_id)
        kb_metas.append({
            "source": f"Verified Q&A Bank #{p['num']}",
            "type": "qa"
        })
    
    # Batch insert into QA collection
    batch_size = 200
    added_qa = 0
    for i in range(0, len(qa_docs), batch_size):
        batch_docs = qa_docs[i:i+batch_size]
        batch_ids = qa_ids[i:i+batch_size]
        batch_metas = qa_metas[i:i+batch_size]
        try:
            qa_col.upsert(
                documents=batch_docs,
                ids=batch_ids,
                metadatas=batch_metas
            )
            added_qa += len(batch_docs)
            print(f"   QA collection: {added_qa}/{len(qa_docs)} ingested...")
        except Exception as e:
            print(f"   ⚠️ QA batch error: {e}")
    
    # Batch insert into main KB collection
    added_kb = 0
    for i in range(0, len(kb_docs), batch_size):
        batch_docs = kb_docs[i:i+batch_size]
        batch_ids = kb_ids[i:i+batch_size]
        batch_metas = kb_metas[i:i+batch_size]
        try:
            kb_col.upsert(
                documents=batch_docs,
                ids=batch_ids,
                metadatas=batch_metas
            )
            added_kb += len(batch_docs)
            print(f"   KB collection: {added_kb}/{len(kb_docs)} ingested...")
        except Exception as e:
            print(f"   ⚠️ KB batch error: {e}")
    
    # Verify
    qa_count = qa_col.count()
    kb_count = kb_col.count()
    print(f"\n✅ DONE!")
    print(f"   tatva_qa collection: {qa_count} documents")
    print(f"   tatva_knowledge collection: {kb_count} documents")
    
    # Test retrieval
    print(f"\n🔍 Test retrieval from QA collection:")
    test_queries = [
        "What is Satnam?",
        "Why was Kaal expelled from Satlok?",
        "story of ranka banka"
    ]
    for q in test_queries:
        results = qa_col.query(query_texts=[q], n_results=3, include=['documents','distances','metadatas'])
        docs = results['documents'][0]
        dists = results['distances'][0]
        metas = results['metadatas'][0]
        print(f"\n   Q: {q}")
        for i, (doc, dist, meta) in enumerate(zip(docs, dists, metas)):
            sim = 1 / (1 + dist)
            print(f"   [{i+1}] sim={sim:.3f} src={meta.get('source','')} q={meta.get('question','')[:60]}")
            print(f"       {doc[:120]}...")

if __name__ == "__main__":
    ingest_qa()
