import os, fitz, chromadb
from chromadb.utils import embedding_functions

print("Loading Multilingual Model...")
ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")

client = chromadb.HttpClient(host='localhost', port=8000)

try:
    client.delete_collection(name="tatva_knowledge")
    print("Wiped old collection to make room for Multilingual vectors.")
except:
    pass

collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)

# ✅ FIX 1: Pointing directly to the folder in your screenshot
pdf_dir = os.path.expanduser("~/pdfs")

if not os.path.exists(pdf_dir):
    print(f"Error: Could not find folder at {pdf_dir}")
else:
    documents = []
    metadatas = []
    ids = []
    pdf_filepaths = []

    # ✅ FIX 2: Deep diving into all sub-folders (os.walk)
    for root, dirs, files in os.walk(pdf_dir):
        for file in files:
            if file.lower().endswith(".pdf"):
                pdf_filepaths.append(os.path.join(root, file))

    if not pdf_filepaths:
        print(f"⚠️ No PDFs found in '{pdf_dir}' or any of its subfolders.")
    else:
        print(f"✅ Found {len(pdf_filepaths)} PDFs across all sub-folders! Processing now...")
        for filepath in pdf_filepaths:
            filename = os.path.basename(filepath)
            print(f"Reading: {filename}...")
            try:
                doc = fitz.open(filepath)
                text = "".join([page.get_text() + "\n" for page in doc])
                
                chunk_size = 2500
                for i in range(0, len(text), chunk_size):
                    chunk = text[i:i+chunk_size].strip()
                    if len(chunk) > 50:
                        documents.append(chunk)
                        metadatas.append({"source": filename, "type": "pdf"})
                        ids.append(f"{filename}_{i}")
            except Exception as e:
                print(f"Could not read {filename}: {e}")

    if documents:
        print(f"Adding {len(documents)} chunks to ChromaDB. This might take a few minutes...")
        batch_size = 100
        for i in range(0, len(documents), batch_size):
            collection.add(
                documents=documents[i:i+batch_size],
                metadatas=metadatas[i:i+batch_size],
                ids=ids[i:i+batch_size]
            )
        print("✅ ALL PDFs INGESTED SUCCESSFULLY! Database is now packed with your Hindi/Sanskrit data.")
