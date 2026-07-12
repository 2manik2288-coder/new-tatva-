import os, fitz, chromadb, multiprocessing
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

CHUNK_SIZE = 2500
BATCH_SIZE = 5  # Process 5 files at a time to save RAM

def is_garbage_font(text):
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    return sum(1 for c in text[:5000] if c in garbage_chars) > 20

def process_single_pdf(filepath):
    filename = os.path.basename(filepath)
    local_docs, local_metas = [], []
    try:
        doc = fitz.open(filepath)
        fast_text = "".join([page.get_text() + "\n" for page in doc])
        if is_garbage_font(fast_text):
            images = convert_from_path(filepath, dpi=150) # Lower DPI to save RAM
            full_text = "".join([pytesseract.image_to_string(img, lang='hin+eng') for img in images])
        else:
            full_text = fast_text
        for i in range(0, len(full_text), CHUNK_SIZE):
            chunk = full_text[i:i+CHUNK_SIZE].strip()
            if len(chunk) > 50:
                local_docs.append(chunk)
                local_metas.append({"source": filename, "type": "pdf"})
    except Exception as e:
        print(f"Error in {filename}: {e}")
    return local_docs, local_metas, filename

if __name__ == '__main__':
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
    client = chromadb.HttpClient(host='localhost', port=8000)
    collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)
    
    # Check already processed files
    existing_files = set()
    try:
        res = collection.get(include=['metadatas'])
        if res and 'metadatas' in res:
            for m in res['metadatas']:
                if m and 'source' in m: existing_files.add(m['source'])
    except: pass
    
    pdf_dir = os.path.expanduser("~/pdfs")
    all_files = [os.path.join(root, f) for root, _, files in os.walk(pdf_dir) for f in files if f.lower().endswith(".pdf")]
    files_to_process = [f for f in all_files if os.path.basename(f) not in existing_files]

    print(f"✅ Found {len(all_files)} total. {len(files_to_process)} remaining to process.")
    
    # Process in small batches to prevent OOM
    for i in range(0, len(files_to_process), BATCH_SIZE):
        batch = files_to_process[i:i+BATCH_SIZE]
        print(f"Processing batch {i//BATCH_SIZE + 1}...")
        
        with multiprocessing.Pool(processes=min(len(batch), 4)) as pool:
            results = pool.map(process_single_pdf, batch)
            
        for docs, metas, filename in results:
            if docs:
                collection.add(documents=docs, metadatas=metas, ids=[f"{filename}_{j}" for j in range(len(docs))])
                print(f"Uploaded {filename}")
    print("✅ Ingestion complete!")
