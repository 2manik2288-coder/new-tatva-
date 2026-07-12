const STOPWORDS = new Set([
  // English Stopwords
  'a','an','and','are','as','at','be','but','by','for','if','in','into','is','it','no','not','of','on','or','such','that','the','their','then','there','these','they','this','to','was','will','with',
  // Hinglish Stopwords (Filters out grammar so AI focuses on pure Hindi entities)
  'kya','hai','kaise','kyun','kab','kahan','kaun','kitna','kisne','kisko','kiski','kiska','ki','ke','ka','ko','se','mein','par','aur','ya','hain','tha','thi','the','hun','ho','ye','wo','is','us','in','un','bhi','hi','to'
]);

class BM25Index {
  constructor() {
    this.ready = false;
    this.docs = [];
    this.docLengths = [];
    this.avgDocLen = 0;
    this.docFreqs = {};
    this.idf = {};
    this.k1 = 1.2;
    this.b = 0.75;
  }

  tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w));
  }

  async buildFromChroma(collection, name) {
    try {
      console.log(`[BM25] Building index for ${name}...`);
      const results = await collection.get({ include: ['documents', 'metadatas'] });
      const documents = results.documents || [];
      const metadatas = results.metadatas || [];
      
      this.docs = [];
      this.docLengths = [];
      this.docFreqs = {};
      let totalLen = 0;

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const meta = metadatas[i] || {};
        if (!doc) continue;

        const tokens = this.tokenize(doc);
        this.docs.push({ text: doc, meta, tokens });
        this.docLengths.push(tokens.length);
        totalLen += tokens.length;

        const uniqueTokens = new Set(tokens);
        for (const token of uniqueTokens) {
          this.docFreqs[token] = (this.docFreqs[token] || 0) + 1;
        }
      }

      const N = this.docs.length;
      this.avgDocLen = N > 0 ? totalLen / N : 0;

      // Calculate IDF
      this.idf = {};
      for (const [token, df] of Object.entries(this.docFreqs)) {
        this.idf[token] = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      }

      this.ready = true;
      console.log(`[BM25] Built index for ${name} with ${N} documents.`);
    } catch (err) {
      console.error(`[BM25] Error building index:`, err.message);
      this.ready = false;
    }
  }

  search(query, topK = 10) {
    if (!this.ready) return [];
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = [];
    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      const docLen = this.docLengths[i];
      let score = 0;

      const tf = {};
      for (const token of doc.tokens) {
        tf[token] = (tf[token] || 0) + 1;
      }

      for (const token of queryTokens) {
        if (this.idf[token] && tf[token]) {
          const freq = tf[token];
          const num = freq * (this.k1 + 1);
          const den = freq + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen));
          score += this.idf[token] * (num / den);
        }
      }

      if (score > 0) {
        scores.push({ text: doc.text, meta: doc.meta, bm25Score: score });
      }
    }

    return scores.sort((a, b) => b.bm25Score - a.bm25Score).slice(0, topK);
  }
}

module.exports = { BM25Index, STOPWORDS };