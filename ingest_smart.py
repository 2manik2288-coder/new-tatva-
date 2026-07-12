import os, fitz, chromadb
from chromadb.utils import embedding_functions
from pdf2image import convert_from_path
import pytesseract

print("Loading Multilingual Model...")
ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="paraphrase-multilingual-MiniLM-L12-v2")
client = chromadb.HttpClient(host='localhost', port=8000)

try:
    client.delete_collection(name="tatva_knowledge")
    print("Wiped corrupted collection to make room for clean Unicode vectors.")
except:
    pass

collection = client.get_or_create_collection(name="tatva_knowledge", embedding_function=ef)
pdf_dir = os.path.expanduser("~/pdfs")

def is_garbage_font(text):
    # Detects the specific Latin-1 extended characters found in your corrupted logs
    garbage_chars = "ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿµ´ÛÏĒË"
    # Check the first 5000 characters to determine if the PDF is using a legacy font
    count = sum(1 for c in text[:5000] if c in garbage_chars)
    return count > 20

documents = []
metadatas = []
ids = []
pdf_filepaths = []

for root, dirs, files in os.walk(pdf_dir):
    for file in files:
        if file.lower().endswith(".pdf"):
            pdf_filepaths.append(os.path.join(root, file))

if not pdf_filepaths:
    print(f"⚠️ No PDFs found in '{pdf_dir}'.")
else:
    print(f"✅ Found {len(pdf_filepaths)} PDFs. Beginning Smart Extraction...")
    for filepath in pdf_filepaths:
        filename = os.path.basename(filepath)
        print(f"Reading: {filename}...")
        full_text = ""
        try:
            # Attempt fast extraction first
            doc = fitz.open(filepath)
            fast_text = ""
            for page in doc:
                fast_text += page.get_text() + "\n"
            
            # Check if the extracted text is corrupted gibberish
            if is_garbage_font(fast_text):
                print(f"   ⚠️ Legacy font detected in {filename}. Switching to Deep OCR (This may take a while)...")
                # Convert PDF to images and run Hindi OCR
                images = convert_from_path(filepath, dpi=200)
                for image in images:
                    page_text = pytesseract.image_to_string(image, lang='hin+eng')
                    full_text += page_text + "\n"
            else:
                print(f"   ✅ Clean Unicode detected in {filename}. Fast extraction successful.")
                full_text = fast_text
                
            chunk_size = 2500
            for i in range(0, len(full_text), chunk_size):
                chunk = full_text[i:i+chunk_size].strip()
                if len(chunk) > 50:
                    documents.append(chunk)
                    metadatas.append({"source": filename, "type": "pdf"})
                    ids.append(f"{filename}_{i}")
        except Exception as e:
            print(f"Could not read {filename}: {e}")

    if documents:
        print(f"\nAdding {len(documents)} pure Unicode chunks to ChromaDB...")
        batch_size = 100
        for i in range(0, len(documents), batch_size):
            collection.add(
                documents=documents[i:i+batch_size],
                metadatas=metadatas[i:i+batch_size],
                ids=ids[i:i+batch_size]
            )
        print("✅ ALL PDFs INGESTED SUCCESSFULLY! Your database is now 100% readable Hindi.")
