import sys, json
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')

if not sys.stdin.isatty():
    try:
        texts = json.loads(sys.stdin.read())
        print(json.dumps(model.encode(texts).tolist()))
        sys.exit(0)
    except:
        pass

if len(sys.argv) > 1:
    print(json.dumps(model.encode([sys.argv[1]]).tolist()))
