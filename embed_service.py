import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
from sentence_transformers import SentenceTransformer

print("Loading Multilingual AI Model for fast processing...")
model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')

class EmbedHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        texts = json.loads(post_data.decode('utf-8'))
        embeddings = model.encode(texts).tolist()
        
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(embeddings).encode('utf-8'))

    def log_message(self, format, *args):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5002
server = HTTPServer(('127.0.0.1', port), EmbedHandler)
print(f"✅ Multilingual Embedding Service running on port {port}")
server.serve_forever()
