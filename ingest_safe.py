import os, fitz, chromadb
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

# Initialize
ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
client = chromadb.HttpClient(host='localhost', port=8000)
collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)

CHUNK_SIZE = 2500

def is_garbage_font(text):
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    return sum(1 for c in text[:5000] if c in garbage_chars) > 20

# 1. Get already ingested files
existing_files = set()
try:
    res = collection.get(include=['metadatas'])
    if res and 'metadatas' in res:
        for m in res['metadatas']:
            if m and 'source' in m: existing_files.add(m['source'])
    print(f"✅ Found {len(existing_files)} files already in database. Skipping these.")
except: pass

# 2. Find remaining
pdf_dir = os.path.expanduser("~/pdfs")
all_pdf_paths = [os.path.join(root, f) for root, _, files in os.walk(pdf_dir) for f in files if f.lower().endswith(".pdf")]
to_process = [f for f in all_pdf_paths if os.path.basename(f) not in existing_files]

print(f"🚀 Found {len(all_pdf_paths)} total. {len(to_process)} remaining to ingest.")

# 3. Process one-by-one (Memory Safe)
for filepath in to_process:
    filename = os.path.basename(filepath)
    print(f"Processing: {filename}...")
    
    try:
        doc = fitz.open(filepath)
        full_text = ""
        # Check font
        sample_text = "".join([page.get_text() for page in doc[:3]])
        
        if is_garbage_font(sample_text):
            print(f"   ⚠️ OCR needed for {filename}")
            images = convert_from_path(filepath, dpi=150)
            for img in images:
                full_text += pytesseract.image_to_string(img, lang='hin+eng') + "\n"
        else:
            print(f"   ✅ Clean text in {filename}")
            full_text = "".join([page.get_text() + "\n" for page in doc])

        # Chunk and Upload immediately
        chunks = [full_text[i:i+CHUNK_SIZE].strip() for i in range(0, len(full_text), CHUNK_SIZE) if len(full_text[i:i+CHUNK_SIZE].strip()) > 50]
        
        if chunks:
            collection.add(
                documents=chunks,
                metadatas=[{"source": filename} for _ in chunks],
                ids=[f"{filename}_{i}" for i in range(len(chunks))]
            )
            print(f"   ✅ Uploaded {len(chunks)} chunks.")
            
    except Exception as e:
        print(f"❌ Error in {filename}: {e}")

print("✅ Ingestion Complete!")
