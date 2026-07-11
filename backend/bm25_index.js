/**
 * BM25 In-Memory Inverted Index for Tatva Knowledge Base
 * 
 * Builds a sparse keyword index from existing ChromaDB chunks at startup.
 * No re-embedding required — operates on raw text.
 * 
 * BM25 parameters: k1=1.5, b=0.75 (standard defaults)
 */

// Comprehensive Hindi + English stopwords shared across the system
const STOPWORDS = new Set([
  // English function words
  'what', 'who', 'how', 'why', 'when', 'where', 'which', 'is', 'are', 'was',
  'were', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will',
  'shall', 'may', 'might', 'tell', 'me', 'about', 'the', 'a', 'an', 'of',
  'in', 'from', 'for', 'to', 'and', 'or', 'by', 'with', 'this', 'that',
  'it', 'those', 'these', 'many', 'much', 'full', 'story', 'detail', 'its',
  'has', 'have', 'had', 'been', 'being', 'be', 'not', 'no', 'but', 'if',
  'so', 'than', 'too', 'very', 'just', 'also', 'more', 'most', 'some',
  'any', 'all', 'each', 'every', 'both', 'few', 'other', 'such', 'only',
  'own', 'same', 'then', 'there', 'here', 'now', 'up', 'out', 'on', 'off',
  'over', 'under', 'again', 'further', 'once', 'at', 'as',
  // Audited filler verbs, pronouns, and words
  'get', 'got', 'gets', 'getting', 'him', 'her', 'his', 'them', 'their', 
  'they', 'our', 'your', 'you', 'say', 'says', 'said', 'saying', 'ask', 
  'asks', 'asked', 'asking', 'go', 'goes', 'went', 'going', 'make', 
  'makes', 'made', 'making', 'take', 'takes', 'took', 'taking', 'give', 
  'gives', 'gave', 'giving', 'having', 'doing', 'done', 'put', 'puts', 
  'putting', 'come', 'comes', 'came', 'coming', 'want', 'wants', 'wanted', 
  'wanting', 'look', 'looks', 'looked', 'looking', 'find', 'finds', 'found', 
  'finding',
  // Romanized Hindi particles/function words
  'kahani', 'kya', 'kaun', 'kaise', 'kyun', 'kab', 'kahan', 'batao', 'bolo',
  'ki', 'ke', 'ka', 'mein', 'hai', 'hain', 'se', 'ko', 'ne', 'par', 'jo',
  'ye', 'wo', 'vo', 'ek', 'aur', 'ya', 'thi', 'tha', 'the', 'sab', 'koi',
  'bahut', 'konsa', 'konse', 'kaunsa', 'btao', 'bta', 'samjhao', 'samjho',
  'nahi', 'nahin', 'mat', 'na', 'bhi', 'hi', 'ho', 'kar', 'karo', 'karna',
  'hua', 'hui', 'hue', 'hota', 'hoti', 'hote', 'raha', 'rahi', 'rahe',
  'wala', 'wali', 'wale', 'jaise', 'jab', 'tab', 'yahan', 'wahan', 'abhi',
  'phir', 'fir', 'isliye', 'kyunki', 'lekin', 'magar', 'parantu', 'toh',
  'bas', 'sirf', 'kuch', 'apna', 'apni', 'apne', 'unka', 'unki', 'unke',
  'iska', 'iski', 'iske', 'uska', 'uski', 'uske', 'mera', 'meri', 'mere',
  'tera', 'teri', 'tere', 'hamara', 'hamari', 'hamare', 'tumhara', 'tumhari',
  'kitna', 'kitne', 'kitni', 'kaisa', 'kaisi', 'kaise', 'jis', 'jin',
  'inhe', 'unhe', 'isme', 'usme', 'jinhe', 'jinka', 'jinki', 'jinke',
  'yah', 'woh', 'kuch', 'log', 'dono', 'sath', 'baad', 'pehle', 'upar',
  'neeche', 'andar', 'bahar', 'aap', 'tum', 'hum', 'main', 'woh',
  // Devanagari stopwords
  'है', 'हैं', 'से', 'को', 'ने', 'पर', 'और', 'या', 'में', 'का', 'की',
  'के', 'यह', 'वह', 'इस', 'उस', 'जो', 'तो', 'भी', 'ही', 'हो', 'कर',
  'था', 'थी', 'थे', 'हुआ', 'हुई', 'हुए', 'एक', 'दो', 'तीन', 'कुछ',
  'सब', 'कोई', 'बहुत', 'अपना', 'अपनी', 'अपने', 'उनका', 'उनकी', 'उनके',
  'इसका', 'इसकी', 'इसके', 'उसका', 'उसकी', 'उसके', 'मेरा', 'मेरी', 'मेरे',
  'तेरा', 'तेरी', 'तेरे', 'हमारा', 'हमारी', 'हमारे', 'तुम्हारा', 'तुम्हारी',
  'नहीं', 'नही', 'मत', 'ना', 'बस', 'सिर्फ', 'अब', 'तब', 'जब', 'कब',
  'यहाँ', 'वहाँ', 'कहाँ', 'कैसे', 'क्यों', 'क्या', 'कौन', 'कितना', 'कितने',
  'कितनी', 'कैसा', 'कैसी', 'फिर', 'इसलिए', 'क्योंकि', 'लेकिन', 'मगर',
  'परन्तु', 'जैसे', 'ऐसे', 'ऐसा', 'ऐसी', 'वैसे', 'वैसा', 'वैसी',
  'बताओ', 'बोलो', 'करो', 'करना', 'होता', 'होती', 'होते', 'रहा', 'रही',
  'राहे', 'वाला', 'वाली', 'वाले', 'साथ', 'बाद', 'पहले', 'ऊपर', 'नीचे',
  'अंदर', 'बाहर', 'आप', 'तुम', 'हम', 'मैं', 'वो', 'ये', 'जी', 'हाँ',
  'बताइए', 'बताइये', 'समझाओ', 'सुनाओ', 'दीजिए', 'कीजिए'
]);

/**
 * Tokenize text into lowercase words, stripping punctuation.
 * Unicode-aware: handles both Latin and Devanagari.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[।॥,;:!?\.\-\—\–\"\'\(\)\[\]\{\}\/\\<>@#$%^&*+=~`|…]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

class BM25Index {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = [];           // [{id, text, tokens, length}]
    this.invertedIndex = {};  // term -> [{docIdx, tf}]
    this.avgDocLength = 0;
    this.docCount = 0;
    this.idf = {};            // term -> idf score
    this.ready = false;
    this.collectionName = '';
  }

  /**
   * Build index from a ChromaDB collection by fetching all documents in batches.
   */
  async buildFromChroma(collection, collectionName) {
    this.collectionName = collectionName;
    console.log(`[BM25] Building index for "${collectionName}"...`);
    const startTime = Date.now();

    try {
      const totalCount = await collection.count();
      console.log(`[BM25] Collection "${collectionName}" has ${totalCount} documents`);

      if (totalCount === 0) {
        console.log(`[BM25] Empty collection, skipping`);
        return;
      }

      const BATCH_SIZE = 10000;
      let totalTokens = 0;

      for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
        const limit = Math.min(BATCH_SIZE, totalCount - offset);

        try {
          const result = await collection.get({
            limit: limit,
            offset: offset,
            include: ['documents', 'metadatas']
          });

          const documents = result.documents || [];
          const metadatas = result.metadatas || [];
          const ids = result.ids || [];

          for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            if (!doc || doc.length < 20) continue;

            const tokens = tokenize(doc);
            if (tokens.length === 0) continue;

            const docIdx = this.docs.length;
            this.docs.push({
              id: ids[i] || `doc_${docIdx}`,
              text: doc,
              meta: metadatas[i] || {},
              length: tokens.length
            });

            // Build term frequencies
            const tf = {};
            for (const token of tokens) {
              tf[token] = (tf[token] || 0) + 1;
            }

            // Add to inverted index
            for (const [term, freq] of Object.entries(tf)) {
              if (!this.invertedIndex[term]) {
                this.invertedIndex[term] = [];
              }
              this.invertedIndex[term].push({ docIdx, tf: freq });
            }

            totalTokens += tokens.length;
          }
        } catch (batchErr) {
          console.warn(`[BM25] Batch at offset ${offset} failed: ${batchErr.message}`);
          continue;
        }

        if ((offset + BATCH_SIZE) % 10000 === 0 || offset + BATCH_SIZE >= totalCount) {
          console.log(`[BM25] Indexed ${Math.min(offset + BATCH_SIZE, totalCount)}/${totalCount} docs...`);
        }
      }

      this.docCount = this.docs.length;
      this.avgDocLength = this.docCount > 0 ? totalTokens / this.docCount : 1;

      // Precompute IDF for all terms
      for (const [term, postings] of Object.entries(this.invertedIndex)) {
        const df = postings.length;
        this.idf[term] = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
      }

      this.ready = true;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const termCount = Object.keys(this.invertedIndex).length;
      console.log(`[BM25] "${collectionName}" index ready: ${this.docCount} docs, ${termCount} terms, avgLen=${this.avgDocLength.toFixed(0)}, built in ${elapsed}s`);

    } catch (err) {
      console.error(`[BM25] Failed to build index for "${collectionName}":`, err.message);
      this.ready = false;
    }
  }

  /**
   * Search the index with a query string.
   * Returns top-K results sorted by BM25 score.
   */
  search(query, topK = 30) {
    if (!this.ready || this.docCount === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = new Float64Array(this.docCount); // Fast typed array

    for (const token of queryTokens) {
      const postings = this.invertedIndex[token];
      if (!postings) continue;

      const idf = this.idf[token] || 0;
      if (idf <= 0) continue;

      for (const { docIdx, tf } of postings) {
        const docLen = this.docs[docIdx].length;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
        scores[docIdx] += idf * (numerator / denominator);
      }
    }

    // Get top-K by score
    const results = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > 0) {
        results.push({ docIdx: i, score: scores[i] });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK);

    return topResults.map(r => ({
      id: this.docs[r.docIdx].id,
      text: this.docs[r.docIdx].text,
      meta: this.docs[r.docIdx].meta,
      bm25Score: r.score
    }));
  }

  getStats() {
    return {
      collection: this.collectionName,
      ready: this.ready,
      docCount: this.docCount,
      termCount: Object.keys(this.invertedIndex).length,
      avgDocLength: this.avgDocLength
    };
  }
}

module.exports = { BM25Index, STOPWORDS, tokenize };
