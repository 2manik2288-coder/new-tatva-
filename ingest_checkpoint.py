import os, fitz, chromadb, gc
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

CHUNK_SIZE = 2500
BATCH_SIZE = 3  # Chota batch, RAM save karne ke liye

# Initialize
ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
client = chromadb.HttpClient(host='localhost', port=8000)
collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)

def is_garbage_font(text):
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    return sum(1 for c in text[:1000] if c in garbage_chars) > 5

# 1. Load progress
existing_files = set()
try:
    res = collection.get(include=['metadatas'])
    if res and 'metadatas' in res:
        for m in res['metadatas']:
            if m and 'source' in m: existing_files.add(m['source'])
    print(f"📊 Checkpoint: {len(existing_files)} files already ingested.")
except: pass

pdf_dir = os.path.expanduser("~/pdfs")
all_files = [os.path.join(root, f) for root, _, files in os.walk(pdf_dir) for f in files if f.lower().endswith(".pdf")]
to_process = [f for f in all_files if os.path.basename(f) not in existing_files]

print(f"🚀 Total: {len(all_files)}. Remaining to ingest: {len(to_process)}")

# 2. Batch Processing
for i in range(0, len(to_process), BATCH_SIZE):
    batch = to_process[i:i+BATCH_SIZE]
    print(f"\n--- Batch {i//BATCH_SIZE + 1} starting (Files {i+1} to {min(i+BATCH_SIZE, len(to_process))}) ---")
    
    for filepath in batch:
        filename = os.path.basename(filepath)
        print(f"Reading: {filename}...")
        
        try:
            doc = fitz.open(filepath)
            # OCR Check
            sample_text = "".join([page.get_text() for page in doc[:2]])
            use_ocr = is_garbage_font(sample_text)
            
            for page_num in range(len(doc)):
                page_text = ""
                if use_ocr:
                    images = convert_from_path(filepath, dpi=150, first_page=page_num+1, last_page=page_num+1)
                    page_text = pytesseract.image_to_string(images[0], lang='hin+eng')
                    del images
                else:
                    page_text = doc[page_num].get_text()
                
                if len(page_text.strip()) > 50:
                    collection.add(
                        documents=[page_text.strip()],
                        metadatas=[{"source": filename}],
                        ids=[f"{filename}_p{page_num}"]
                    )
                gc.collect() # RAM Flush
            doc.close()
            print(f"   ✅ Done: {filename}")
        except Exception as e:
            print(f"   ❌ Error in {filename}: {e}")
            
    print(f"--- Batch {i//BATCH_SIZE + 1} complete. System Checkpoint Saved. ---")
    gc.collect() 

print("✅ ALL PDFs INGESTED SUCCESSFULLY!")
