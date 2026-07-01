#!/usr/bin/env python3
import sys
import json
import torch
from http.server import BaseHTTPRequestHandler, HTTPServer
from sentence_transformers import SentenceTransformer

# Device auto-detection
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"
else:
    DEVICE = "cpu"

print(f"Loading SentenceTransformer on device: {DEVICE}...", flush=True)
model = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', device=DEVICE)
print("Embedding model loaded successfully! Starting HTTP service...", flush=True)

class EmbeddingHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logging request details to keep output clean
        pass

    def do_POST(self):
        if self.path == '/embed':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                texts = json.loads(post_data)
                if not isinstance(texts, list):
                    texts = [texts]
                
                embeddings = model.encode(texts, normalize_embeddings=True).tolist()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(embeddings).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy"}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

def run(port=5002):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, EmbeddingHTTPHandler)
    print(f"Embedding service running on http://127.0.0.1:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("Embedding service stopped.", flush=True)

if __name__ == '__main__':
    port = 5002
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    run(port)
