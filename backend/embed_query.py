#!/usr/bin/env python3
"""Generate embedding for a query using sentence-transformers."""
import sys
import json
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('all-MiniLM-L6-v2')
query = sys.argv[1] if len(sys.argv) > 1 else ""
embedding = model.encode(query).tolist()
print(json.dumps(embedding))
