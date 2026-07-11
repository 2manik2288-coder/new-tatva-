const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Parse CLI args
const args = process.argv.slice(2);
let testSetFile = 'eval_testset.json';
let tag = 'default';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--testset' && args[i + 1]) testSetFile = args[++i];
  if (args[i] === '--tag' && args[i + 1]) tag = args[++i];
}

const TEST_SET_PATH = path.join(__dirname, testSetFile);
const RESULTS_DIR = path.join(__dirname, 'eval_results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function matchBilingualFact(fact, responseText) {
  const text = responseText.toLowerCase();
  const f = fact.toLowerCase();

  const synonyms = {
    'vishnu': ['vishnu', 'विष्णु', 'vishnuji'],
    'brahma': ['brahma', 'ब्रह्मा', 'brahmaji'],
    'shiva': ['shiva', 'शिव', 'shivji', 'mahesh', 'shiv'],
    'trinity': ['trinity', 'त्रिदेव', 'tridev'],
    'kaal': ['kaal', 'काल', 'jyoti niranjan', 'niranjan'],
    'creation': ['creation', 'सृष्टि', 'रचना', 'srishti', 'rachna'],
    'soul': ['soul', 'आत्मा', 'aatma'],
    'whirlpool': ['whirlpool', 'भंवर', 'bhanwar', 'gufa', 'भनवर', 'bhanvar'],
    'kala': ['kala', 'कला', 'कलाएं', 'kalaen', 'kalas'],
    'tenth': ['tenth', 'दसवां', 'daswan', 'dasvan', '10th', 'dasam'],
    'door': ['door', 'द्वार', 'dwaar', 'dwar', 'dvara'],
    'mantra': ['mantra', 'मंत्र', 'naam', 'soham', 'satnam', 'sarnaam'],
    'lord': ['lord', 'प्रभु', 'भगवान', 'bhagwan', 'ishwar', 'swami'],
    'avatar': ['avatar', 'अवतार', 'avtar'],
    'duration': ['duration', 'lifespan', 'आयु', 'umar', 'aayu', 'period'],
    'temporary': ['temporary', 'अस्थायी', 'nashwar', 'perishable'],
    'immortal': ['immortal', 'अमर', 'avinashi', 'shaswat'],
    '16': ['16', 'sixteen', 'सोलह', '16 kalas', '16 kala', 'sixteen kalas', 'solah'],
    '7': ['7', 'seven', 'सात', 'sankh', '7 sankh'],
    'god': ['god', 'परमात्मा', 'भगवान', 'kabir', 'kavir', 'purush'],
    'womb': ['womb', 'गर्भ', 'garbh', 'womb-trap'],
    'kola': ['kola', 'gola', 'shell', 'bomb'],
    'salvation': ['salvation', 'mukti', 'moksha', 'liberation', 'मोक्ष', 'मुक्ति'],
    'krishna': ['krishna', 'कृष्ण', 'krishan', 'krishnaji', 'krishn'],
    'sheikh taqi': ['sheikh taqi', 'sheikh', 'taqi', 'शेख तकी', 'taki'],
    'kamali': ['kamali', 'कमली'],
    'draupadi': ['draupadi', 'द्रौपदी'],
    'ramanand': ['ramanand', 'रामानंद', 'ramanandji'],
    'namdev': ['namdev', 'नामदेव'],
    'species': ['species', 'योनि', 'yoni', 'yonis', 'प्रजातियां', 'species'],
    'garibdas': ['garibdas', 'गरीबदास', 'garib das', 'garibdasji', 'गरीब दास', 'गरिबदास', 'गरिब दास'],
    'devotee': ['devotee', 'भक्त', 'bhakt', 'bhakta', 'devotees', 'रंका', 'बांका', 'ranka', 'banka'],
    'butcher': ['butcher', 'कसाई', 'kasai'],
    'gita': ['gita', 'गीता', 'geeta'],
    'yajna': ['yajna', 'यज्ञ', 'yagya', 'yagna'],
    'swaha': ['swaha', 'स्वाहा'],
    'sin': ['sin', 'पाप', 'paap', 'sins'],
    'human': ['human', 'मनुष्य', 'manushya', 'manushya janam', 'manushya janam ka mahatva', 'manushya janam', 'manav', 'मानव', 'insan', 'इंसान'],
    'form': ['form', 'साकार', 'sakar', 'sakaar', 'aakaar', 'niraakaar', 'nirakar', 'निराकार'],
    'guru': ['guru', 'सतगुरु', 'satguru', 'गुरु', 'गुरु', 'satguru'],
    'universe': ['universe', 'universes', 'ब्रह्मांड', 'brahmand', 'brahmands', 'सृष्टि', 'srishti', 'ब्रह्माण्ड', 'ब्रम्हांड', 'ब्रहांड'],
    'eternal': ['eternal', 'अमर', 'avinashi', 'shaswat', 'perpetual', 'sada', 'satlok'],
    'initiation': ['initiation', 'दीक्षा', 'diksha', 'naam diksha', 'initiate'],
    'quran': ['quran', 'कुरान', 'kuran', 'क़ुरान'],
    'alcohol': ['alcohol', 'शराब', 'sharab', 'madira', 'liquor'],
    'heaven': ['heaven', 'स्वर्ग', 'swarg'],
    'hell': ['hell', 'नरक', 'narak'],
    'pitra': ['pitra', 'पितृ', 'pitru', 'ancestor', 'ancestors', 'pitra puja'],
    'devot': ['devot', 'bhakt', 'भक्त', 'pativrata', 'loyal', 'devoted'],
    'trikuti': ['trikuti', 'त्रिकुटी'],
    'tenth door': ['tenth door', 'dasam dwaar', 'dasam dwar', 'दसवां द्वार', 'दसवें द्वार', '10th door'],
    'sarnaam': ['sarnaam', 'sar shabad', 'saar shabad', 'sarnaam', 'सारनाम', 'सार शब्द', 'सारशब्द'],
    'satnam': ['satnam', 'सत्नाम', 'सत्यनाम', 'satya naam', 'satnaam', 'सत्य नाम'],
    'descent': ['descent', 'avataran', 'अवतरण', 'प्रकट', 'prakat', 'descend'],
    'infant': ['infant', 'शिशु', 'balak', 'बालक', 'child', 'shishu'],
    'lotus': ['lotus', 'कमल', 'kamal', 'lotus flower'],
    'karma': ['karma', 'कर्म', 'karam', 'karmas'],
    'mantras': ['mantras', 'mantra', 'मंत्र', 'naam', 'jaap', 'jap', 'मंत्रों'],
    'power': ['power', 'शक्ति', 'shakti', 'urja', 'energy'],
    'roots': ['roots', 'जड़', 'mool', 'root'],
    'branches': ['branches', 'शाखाएं', 'shakha', 'daal'],
    'saw': ['saw', 'करौंत', 'karot', 'आरी'],
    'staged': ['staged', 'नाटक', 'naatak', 'leela', 'लीला', 'acting', 'dikhawa', 'drama'],
    'tradition': ['tradition', 'परंपरा', 'parampara', 'reeti', 'maryada', 'मर्यादा', 'custom'],
    'debt': ['debt', 'ऋण', 'karz', 'karza'],
    'sukdev': ['sukdev', 'सुखदेव', 'shukdev'],
    'mansur': ['mansur', 'मंसूर'],
    'anal haq': ['anal haq', 'अनल हक'],
    'merchant': ['merchant', 'bania', 'seth', 'vyapari', 'वणिक'],
    'lie': ['lie', 'झूठ', 'jhooth'],
    'curse': ['curse', 'श्राप', 'shrap']
  };

  const list = synonyms[f] || [f];
  return list.some(syn => text.includes(syn));
}

async function runEval() {
  console.log('Starting Accuracy Evaluation Harness...');
  console.log(`Test set: ${testSetFile} | Tag: ${tag}`);

  if (!fs.existsSync(TEST_SET_PATH)) {
    console.error(`Test set not found at ${TEST_SET_PATH}`);
    process.exit(1);
  }

  const testCases = JSON.parse(fs.readFileSync(TEST_SET_PATH, 'utf8'));
  console.log(`Loaded ${testCases.length} test cases\n`);

  const results = [];
  let totalExpectedFacts = 0;
  let matchedExpectedFacts = 0;
  let totalPassed = 0;
  let totalHallucinations = 0;
  let totalLeaks = 0;
  let totalMissingFacts = 0;
  let totalInsufficientKB = 0;

  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    const qId = tc.id || (idx + 1);
    console.log(`[${idx + 1}/${testCases.length}] Q${qId}: "${tc.question}"`);

    try {
      const { text: responseText, meta } = await getChatResponse(tc.question);

      // 1. Expected Facts Check
      const expectedResults = tc.expected_facts.map(fact => {
        const found = matchBilingualFact(fact, responseText);
        return { fact, found };
      });
      const factsMatchedCount = expectedResults.filter(r => r.found).length;
      const expectedFactsPercentage = tc.expected_facts.length > 0
        ? (factsMatchedCount / tc.expected_facts.length) * 100
        : 100;

      totalExpectedFacts += tc.expected_facts.length;
      matchedExpectedFacts += factsMatchedCount;

      // 2. Forbidden Facts Check (Hallucinations)
      const forbiddenResults = (tc.forbidden_facts || []).map(fact => {
        const found = responseText.toLowerCase().includes(fact.toLowerCase());
        return { fact, found };
      });
      const forbiddenFound = forbiddenResults.filter(r => r.found);
      const hasHallucination = forbiddenFound.length > 0;

      // 3. Leakage Checks
      const leakageFindings = [];
      const citationRegex = /\[\d+(?:\s*,\s*\d+)*\]/g;
      const citationMatches = responseText.match(citationRegex);
      if (citationMatches) {
        leakageFindings.push(`Citation numbers leaked: ${citationMatches.join(', ')}`);
      }
      const leakKeywords = ['Q&A Bank', 'Verified', 'chunk', 'chunk_id', 'tatva_knowledge', 'tatva_qa'];
      leakKeywords.forEach(kw => {
        if (responseText.toLowerCase().includes(kw.toLowerCase())) {
          leakageFindings.push(`Internal term leaked: "${kw}"`);
        }
      });
      const hasLeakage = leakageFindings.length > 0;

      // 4. Insufficient KB false negative detection
      const isInsufficientKB = responseText.toLowerCase().includes('does not have sufficient information') ||
        responseText.toLowerCase().includes('do not specifically address');

      if (isInsufficientKB) totalInsufficientKB++;

      // Determine Pass / Fail
      const missingAnyFacts = factsMatchedCount < tc.expected_facts.length;
      const passed = !missingAnyFacts && !hasHallucination && !hasLeakage;

      if (passed) totalPassed++;
      if (hasHallucination) totalHallucinations++;
      if (hasLeakage) totalLeaks++;
      if (missingAnyFacts) totalMissingFacts++;

      results.push({
        id: qId,
        question: tc.question,
        covers_map_entry: tc.covers_map_entry || null,
        expected_facts: tc.expected_facts,
        forbidden_facts: tc.forbidden_facts || [],
        response: responseText,
        retrieval_meta: meta,
        is_insufficient_kb: isInsufficientKB,
        metrics: {
          expected_facts_matched: factsMatchedCount,
          expected_facts_total: tc.expected_facts.length,
          expected_facts_percentage: expectedFactsPercentage,
          expected_results: expectedResults,
          forbidden_found: forbiddenFound.map(r => r.fact),
          has_hallucination: hasHallucination,
          leakage_findings: leakageFindings,
          has_leakage: hasLeakage,
          passed,
          fail_reasons: [
            ...(missingAnyFacts ? ['Missing expected facts'] : []),
            ...(hasHallucination ? ['Contains forbidden hallucination facts'] : []),
            ...(hasLeakage ? ['Leaked internal metadata artifacts'] : []),
            ...(isInsufficientKB ? ['Returned insufficient-KB fallback'] : [])
          ]
        }
      });

      const status = passed ? 'PASS' : 'FAIL';
      const statusIcon = passed ? '+' : '-';
      console.log(`    [${statusIcon}] ${status} | Facts: ${factsMatchedCount}/${tc.expected_facts.length}${isInsufficientKB ? ' | INSUFFICIENT_KB' : ''}${hasHallucination ? ' | HALLUCINATION' : ''}`);
      if (!passed) {
        const missing = expectedResults.filter(r => !r.found).map(r => r.fact);
        if (missing.length) console.log(`    Missing: ${missing.join(', ')}`);
      }

      // Rate limit pause
      await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      results.push({
        id: qId,
        question: tc.question,
        covers_map_entry: tc.covers_map_entry || null,
        error: err.message,
        metrics: { passed: false, fail_reasons: [`Request error: ${err.message}`] }
      });
      totalMissingFacts++;
    }
  }

  // Generate Final Report
  const overallAccuracy = (totalPassed / testCases.length) * 100;
  const overallFactRecall = totalExpectedFacts > 0 ? (matchedExpectedFacts / totalExpectedFacts) * 100 : 100;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFilename = `eval_${tag}_${timestamp}.json`;
  const resultsPath = path.join(RESULTS_DIR, resultsFilename);

  // Per-category breakdown for rewrite/hindiBridge regression tracking
  const categoryStats = {};
  results.forEach(r => {
    const cat = r.covers_map_entry || 'none';
    if (!categoryStats[cat]) categoryStats[cat] = { total: 0, passed: 0, insufficient: 0 };
    categoryStats[cat].total++;
    if (r.metrics?.passed) categoryStats[cat].passed++;
    if (r.is_insufficient_kb) categoryStats[cat].insufficient++;
  });

  const report = {
    timestamp: new Date().toISOString(),
    tag,
    test_set: testSetFile,
    summary: {
      total_questions: testCases.length,
      passed: totalPassed,
      failed: testCases.length - totalPassed,
      grounded_accuracy: overallAccuracy.toFixed(2) + '%',
      fact_recall: overallFactRecall.toFixed(2) + '%',
      insufficient_kb_fallbacks: totalInsufficientKB,
      failure_breakdown: {
        hallucination_failures: totalHallucinations,
        missing_facts_failures: totalMissingFacts,
        leakage_failures: totalLeaks
      }
    },
    category_breakdown: categoryStats,
    results
  };

  fs.writeFileSync(resultsPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n==================================================');
  console.log(`EVALUATION REPORT [${tag}]`);
  console.log('==================================================');
  console.log(`Total Questions:       ${report.summary.total_questions}`);
  console.log(`Passed:                ${report.summary.passed}`);
  console.log(`Failed:                ${report.summary.failed}`);
  console.log(`Grounded Accuracy:     ${report.summary.grounded_accuracy}`);
  console.log(`Fact Recall:           ${report.summary.fact_recall}`);
  console.log(`Insufficient-KB:       ${report.summary.insufficient_kb_fallbacks}`);
  console.log('--------------------------------------------------');
  console.log('Failure Breakdown:');
  console.log(`   Missing Facts:      ${totalMissingFacts}`);
  console.log(`   Hallucinations:     ${totalHallucinations}`);
  console.log(`   Internal Leaks:     ${totalLeaks}`);
  console.log('==================================================');
  console.log(`Saved to: ./eval_results/${resultsFilename}\n`);
}

function getChatResponse(question) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({
        method: 'post',
        url: 'http://localhost:5001/api/chat',
        data: {
          message: question,
          conversationHistory: [],
          userId: 'eval-harness-user'
        },
        responseType: 'stream',
        timeout: 120000
      });

      let fullText = '';
      let meta = {};
      let buffer = '';

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const message = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (message.startsWith('data: ')) {
            try {
              const data = JSON.parse(message.slice(6));
              if (data.type === 'token') {
                fullText += data.text;
              } else if (data.type === 'done') {
                meta = {
                  sourceLabel: data.sourceLabel,
                  model: data.model,
                  chunksUsed: data.chunksUsed,
                  webResultsUsed: data.webResultsUsed
                };
              }
            } catch (err) {
              // Ignore partial JSON
            }
          }
        }
      });

      response.data.on('end', () => {
        resolve({ text: fullText.trim(), meta });
      });

      response.data.on('error', err => {
        reject(err);
      });

    } catch (err) {
      reject(err);
    }
  });
}

runEval();
