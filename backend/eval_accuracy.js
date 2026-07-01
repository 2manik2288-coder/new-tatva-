const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TEST_SET_PATH = path.join(__dirname, 'eval_testset.json');
const RESULTS_DIR = path.join(__dirname, 'eval_results');

// Ensure results directory exists
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

async function runEval() {
  console.log('🚀 Starting Accuracy Evaluation Harness...');
  
  if (!fs.existsSync(TEST_SET_PATH)) {
    console.error(`❌ Test set not found at ${TEST_SET_PATH}`);
    process.exit(1);
  }

  const testCases = JSON.parse(fs.readFileSync(TEST_SET_PATH, 'utf8'));
  console.log(`Loaded ${testCases.length} test cases from ${TEST_SET_PATH}\n`);

  const results = [];
  let totalExpectedFacts = 0;
  let matchedExpectedFacts = 0;
  let totalPassed = 0;
  let totalHallucinations = 0;
  let totalLeaks = 0;
  let totalMissingFacts = 0;

  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    console.log(`[${idx + 1}/${testCases.length}] Evaluating: "${tc.question}"`);

    try {
      const responseText = await getChatResponse(tc.question);
      
      // ── EVALUATION CHECKS ──
      
      // 1. Expected Facts Check
      const expectedResults = tc.expected_facts.map(fact => {
        const found = responseText.toLowerCase().includes(fact.toLowerCase());
        return { fact, found };
      });
      const factsMatchedCount = expectedResults.filter(r => r.found).length;
      const expectedFactsPercentage = tc.expected_facts.length > 0 
        ? (factsMatchedCount / tc.expected_facts.length) * 100 
        : 100;
      
      totalExpectedFacts += tc.expected_facts.length;
      matchedExpectedFacts += factsMatchedCount;

      // 2. Forbidden Facts Check (Hallucinations)
      const forbiddenResults = tc.forbidden_facts.map(fact => {
        const found = responseText.toLowerCase().includes(fact.toLowerCase());
        return { fact, found };
      });
      const forbiddenFound = forbiddenResults.filter(r => r.found);
      const hasHallucination = forbiddenFound.length > 0;

      // 3. Leakage Checks
      const leakageFindings = [];
      
      // Check for bracket citations [1], [2], [1, 2], etc.
      const citationRegex = /\[\d+(?:\s*,\s*\d+)*\]/g;
      const citationMatches = responseText.match(citationRegex);
      if (citationMatches) {
        leakageFindings.push(`Citation numbers leaked: ${citationMatches.join(', ')}`);
      }

      // Check for internal keyword leakages
      const leakKeywords = ['Q&A Bank', 'Verified', 'chunk', 'chunk_id', 'tatva_knowledge', 'tatva_qa'];
      leakKeywords.forEach(kw => {
        if (responseText.toLowerCase().includes(kw.toLowerCase())) {
          leakageFindings.push(`Internal term leaked: "${kw}"`);
        }
      });

      const hasLeakage = leakageFindings.length > 0;

      // Determine Pass / Fail Status
      const missingAnyFacts = factsMatchedCount < tc.expected_facts.length;
      const passed = !missingAnyFacts && !hasHallucination && !hasLeakage;
      
      if (passed) totalPassed++;
      if (hasHallucination) totalHallucinations++;
      if (hasLeakage) totalLeaks++;
      if (missingAnyFacts) totalMissingFacts++;

      results.push({
        question: tc.question,
        expected_facts: tc.expected_facts,
        forbidden_facts: tc.forbidden_facts,
        response: responseText,
        metrics: {
          expected_facts_matched: factsMatchedCount,
          expected_facts_total: tc.expected_facts.length,
          expected_facts_percentage: expectedFactsPercentage,
          expected_results: expectedResults,
          forbidden_found: forbiddenFound.map(r => r.fact),
          has_hallucination: hasHallucination,
          leakage_findings: leakageFindings,
          has_leakage: hasLeakage,
          passed: passed,
          fail_reasons: [
            ...(missingAnyFacts ? ['Missing expected facts'] : []),
            ...(hasHallucination ? ['Contains forbidden hallucination facts'] : []),
            ...(hasLeakage ? ['Leaked internal metadata artifacts'] : [])
          ]
        }
      });

      console.log(`    Result: ${passed ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`    Expected Facts: ${factsMatchedCount}/${tc.expected_facts.length} (${expectedFactsPercentage.toFixed(1)}%)`);
      if (hasHallucination) {
        console.log(`    ⚠️ Hallucinations found: ${forbiddenFound.map(r => `"${r.fact}"`).join(', ')}`);
      }
      if (hasLeakage) {
        console.log(`    ⚠️ Leakage found: ${leakageFindings.join('; ')}`);
      }
      console.log('─'.repeat(50));

      // Small pause to avoid aggressive rate limiting
      await new Promise(resolve => setTimeout(resolve, 800));

    } catch (err) {
      console.error(`    ❌ Request Error: ${err.message}`);
      results.push({
        question: tc.question,
        error: err.message,
        metrics: { passed: false, fail_reasons: [`Request error: ${err.message}`] }
      });
      totalMissingFacts++;
      console.log('─'.repeat(50));
    }
  }

  // ── GENERATE FINAL REPORT ──
  const overallAccuracy = (totalPassed / testCases.length) * 100;
  const overallFactRecall = totalExpectedFacts > 0 ? (matchedExpectedFacts / totalExpectedFacts) * 100 : 100;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFilename = `eval_${timestamp}.json`;
  const resultsPath = path.join(RESULTS_DIR, resultsFilename);

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_questions: testCases.length,
      passed: totalPassed,
      failed: testCases.length - totalPassed,
      grounded_accuracy_score: overallAccuracy.toFixed(2) + '%',
      fact_recall_score: overallFactRecall.toFixed(2) + '%',
      failure_breakdown: {
        hallucination_failures: totalHallucinations,
        missing_facts_failures: totalMissingFacts,
        leakage_failures: totalLeaks
      }
    },
    results
  };

  fs.writeFileSync(resultsPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n==================================================');
  console.log('📊 EVALUATION COMPLETE REPORT');
  console.log('==================================================');
  console.log(`📅 Timestamp:              ${report.timestamp}`);
  console.log(`📝 Total Questions:       ${report.summary.total_questions}`);
  console.log(`✅ Passed:                ${report.summary.passed}`);
  console.log(`❌ Failed:                ${report.summary.failed}`);
  console.log(`🎯 Grounded Accuracy:     ${report.summary.grounded_accuracy_score}`);
  console.log(`📖 Fact Recall Score:     ${report.summary.fact_recall_score}`);
  console.log('--------------------------------------------------');
  console.log('❌ Failure Breakdown:');
  console.log(`   - Missing Facts:       ${totalMissingFacts}`);
  console.log(`   - Hallucinations:      ${totalHallucinations}`);
  console.log(`   - Internal Leaks:      ${totalLeaks}`);
  console.log('==================================================');
  console.log(`💾 Detailed results saved to: ./eval_results/${resultsFilename}\n`);
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
        timeout: 45000
      });

      let fullText = '';
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
              }
            } catch (err) {
              // Ignore partial JSON parse errors
            }
          }
        }
      });

      response.data.on('end', () => {
        resolve(fullText.trim());
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
