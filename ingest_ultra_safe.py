import os, fitz, chromadb, gc
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

# Initialize Chroma
ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
client = chromadb.HttpClient(host='localhost', port=8000)
collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)

def is_garbage_font(text):
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    return sum(1 for c in text[:1000] if c in garbage_chars) > 5

# 1. Get already ingested files
existing_files = set()
try:
    res = collection.get(include=['metadatas'])
    if res and 'metadatas' in res:
        for m in res['metadatas']:
            if m and 'source' in m: existing_files.add(m['source'])
    print(f"✅ Found {len(existing_files)} files already in database. Skipping these.")
except: pass

pdf_dir = os.path.expanduser("~/pdfs")
all_files = [os.path.join(root, f) for root, _, files in os.walk(pdf_dir) for f in files if f.lower().endswith(".pdf")]
to_process = [f for f in all_files if os.path.basename(f) not in existing_files]

print(f"🚀 Found {len(all_files)} total. {len(to_process)} remaining.")

for filepath in to_process:
    filename = os.path.basename(filepath)
    print(f"Processing: {filename}")
    
    try:
        doc = fitz.open(filepath)
        # Check font using first few pages
        sample_text = "".join([page.get_text() for page in doc[:2]])
        use_ocr = is_garbage_font(sample_text)
        
        for page_num in range(len(doc)):
            page_text = ""
            if use_ocr:
                # Convert only THIS page to image to save RAM
                images = convert_from_path(filepath, dpi=150, first_page=page_num+1, last_page=page_num+1)
                page_text = pytesseract.image_to_string(images[0], lang='hin+eng')
                del images # Free RAM
            else:
                page_text = doc[page_num].get_text()
            
            # Chunking per page to keep memory low
            if len(page_text.strip()) > 50:
                collection.add(
                    documents=[page_text.strip()],
                    metadatas=[{"source": filename}],
                    ids=[f"{filename}_p{page_num}"]
                )
            gc.collect() # Force garbage collection to free RAM
        
        doc.close()
        print(f"   ✅ Finished {filename}")
    except Exception as e:
        print(f"❌ Error in {filename}: {e}")

print("✅ Ingestion Complete!")
