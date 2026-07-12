import chromadb

client = chromadb.HttpClient(host='localhost', port=8000)
collection = client.get_or_create_collection(name="tatva_knowledge")

collection.add(
    documents=[
        "Kabir Saheb explains that there are lotuses (kamal) or chakras in the physical body. Different deities (devi devta) reside in them. For example, Brahma, Vishnu, and Shiva reside in the lower chakras, while Par Brahm resides higher up."
    ],
    metadatas=[{"source": "test_book", "type": "pdf"}],
    ids=["test_chunk_1"]
)
print("✅ Dummy data added to ChromaDB! The AI can now read this.")
