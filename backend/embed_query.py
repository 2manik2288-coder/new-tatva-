#!/usr/bin/env python3
"""Generate embedding for a query using multilingual sentence-transformers."""
import sys
import json
import torch
from sentence_transformers import SentenceTransformer

# Device auto-detection
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"
else:
    DEVICE = "cpu"

model = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', device=DEVICE)

# Support reading JSON array from stdin for fast batched embedding
if not sys.stdin.isatty():
    try:
        input_data = sys.stdin.read().strip()
        queries = json.loads(input_data)
        if not isinstance(queries, list):
            queries = [queries]
        embeddings = model.encode(queries, normalize_embeddings=True).tolist()
        print(json.dumps(embeddings))
        sys.exit(0)
    except Exception as e:
        # Fallback to sys.argv if stdin parsing fails
        pass

query = sys.argv[1] if len(sys.argv) > 1 else ""
embedding = model.encode([query], normalize_embeddings=True).tolist()
# Print just the single embedding list for backward compatibility
print(json.dumps(embedding[0]))
