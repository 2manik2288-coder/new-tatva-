import os, fitz, chromadb, multiprocessing
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

# Config
CHUNK_SIZE = 2500
THREADS = max(1, os.cpu_count() - 1) # Keep 1 core free for OS

def is_garbage_font(text):
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    count = sum(1 for c in text[:5000] if c in garbage_chars)
    return count > 20

def process_single_pdf(filepath):
    filename = os.path.basename(filepath)
    print(f"[{os.getpid()}] Processing: {filename}...")
    local_docs = []
    local_metas = []
    
    try:
        doc = fitz.open(filepath)
        fast_text = ""
        for page in doc:
            fast_text += page.get_text() + "\n"
        
        if is_garbage_font(fast_text):
            images = convert_from_path(filepath, dpi=200)
            full_text = ""
            for image in images:
                full_text += pytesseract.image_to_string(image, lang='hin+eng') + "\n"
        else:
            full_text = fast_text
            
        for i in range(0, len(full_text), CHUNK_SIZE):
            chunk = full_text[i:i+CHUNK_SIZE].strip()
            if len(chunk) > 50:
                local_docs.append(chunk)
                local_metas.append({"source": filename, "type": "pdf"})
    except Exception as e:
        print(f"Error reading {filename}: {e}")
        
    return local_docs, local_metas

if __name__ == '__main__':
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
    client = chromadb.HttpClient(host='localhost', port=8000)
    
    try:
        client.delete_collection(name="tatva_knowledge")
    except: pass
    collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)
    
    pdf_dir = os.path.expanduser("~/pdfs")
    pdf_files = [os.path.join(root, f) for root, _, files in os.walk(pdf_dir) for f in files if f.lower().endswith(".pdf")]

    print(f"🚀 Starting Turbo Ingestion on {THREADS} cores for {len(pdf_files)} PDFs...")
    
    with multiprocessing.Pool(processes=THREADS) as pool:
        results = pool.map(process_single_pdf, pdf_files)
    
    print("✅ All PDFs processed. Uploading to ChromaDB...")
    all_docs, all_metas = [], []
    for docs, metas in results:
        all_docs.extend(docs)
        all_metas.extend(metas)
        
    # Batch upload
    for i in range(0, len(all_docs), 100):
        collection.add(
            documents=all_docs[i:i+100],
            metadatas=all_metas[i:i+100],
            ids=[f"chunk_{j}" for j in range(i, min(i+100, len(all_docs)))]
        )
    print(f"✅ FINISHED! Total chunks in DB: {len(all_docs)}")
