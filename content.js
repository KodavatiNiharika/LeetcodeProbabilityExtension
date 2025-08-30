// content.js
const WEIGHTS = {
  tag: { fam: 0.5, cov: 0.3, acc: 0.2 },
  diff: { fam: 0.5, cov: 0.3, acc: 0.2 },
  final: { W1: 0.3, W2: 0.3, W3: 0.4 }
};
console.log('LeetCode Topic Accuracy content script injected.');

const LEETCODE_GRAPHQL = 'https://leetcode.com/graphql/';

async function fetchLeetCodeGraphQL(query, variables) {
  const res = await fetch(LEETCODE_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`GraphQL fetch failed with status ${res.status}:`, errorText);
    throw new Error(`GraphQL fetch failed: ${res.status} - ${errorText.substring(0, 100)}...`);
  }

  const jsonResponse = await res.json();

  if (jsonResponse.errors) {
    console.error("GraphQL response contained errors:", jsonResponse.errors);
    throw new Error(`GraphQL errors: ${JSON.stringify(jsonResponse.errors)}`);
  }

  // Specific check for problemsetQuestionListV2, might be null if no data
  if (query.includes("problemsetQuestionListV2") && (!jsonResponse.data || !jsonResponse.data.problemsetQuestionListV2)) {
      console.error("Unexpected GraphQL data structure for problemsetQuestionListV2:", jsonResponse);
      throw new Error("Unexpected GraphQL response structure. Missing data.problemsetQuestionListV2 for problemsetQuestionListV2.");
  }

  return jsonResponse; // Return the full JSON response
}

// --- Utility to get current problem details from page URL ---
function getCurrentProblemDetailsFromURL() {
  const match = window.location.pathname.match(/\/problems\/([^\/]+)\/?/);
  if (match) {
    const titleSlug = match[1];
    return titleSlug;
  }
  return null;
}

// --- Function to fetch and cache problem details for given slugs ---
async function fetchAndCacheProblemDetailsForSlugs(slugsToFetch) {
  let currentCache = {};
  const items = await chrome.storage.local.get(['problemDetailsCache']);
  currentCache = items.problemDetailsCache || {};

  const fetchPromises = slugsToFetch.map(async (slug) => {
      if (!currentCache[slug]) { // Only fetch if not already in cache
          const query = `
              query getQuestionDetail($titleSlug: String!) {
                  question(titleSlug: $titleSlug) {
                      questionId
                      title
                      titleSlug
                      difficulty
                      topicTags { name slug }
                  }
              }
          `;
          const data = await fetchLeetCodeGraphQL(query, { titleSlug: slug });
          if (data && data.data && data.data.question) {
              currentCache[slug] = data.data.question;
          } else {
              console.warn(`Could not fetch details for slug: ${slug}`, data);
          }
            // Add a small delay to avoid hitting rate limits for individual problem fetches
          await new Promise(r => setTimeout(r, 100));
      }
  });
  await Promise.all(fetchPromises);
  await chrome.storage.local.set({ problemDetailsCache: currentCache });
  return currentCache;
}


// --- NEW: Compute and cache global difficulty totals and solved counts (Easy/Medium/Hard) via questionList ---
async function updateGlobalDifficultyTotalsAndSolved() {
  try {
    console.log('[Accuracy] Fetching global difficulty totals and solved via questionList...');
    const query = `
      query allDifficultyTotals {
        easyAll: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: EASY }) { total: totalNum }
        easySolved: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: EASY, status: AC }) { total: totalNum }
        mediumAll: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: MEDIUM }) { total: totalNum }
        mediumSolved: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: MEDIUM, status: AC }) { total: totalNum }
        hardAll: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: HARD }) { total: totalNum }
        hardSolved: questionList(categorySlug: "", limit: 1, skip: 0, filters: { difficulty: HARD, status: AC }) { total: totalNum }
      }
    `;
    const data = await fetchLeetCodeGraphQL(query, {});
    const res = data && data.data;
    const totals = {
      Easy: res?.easyAll?.total ?? 0,
      Medium: res?.mediumAll?.total ?? 0,
      Hard: res?.hardAll?.total ?? 0
    };
    const solved = {
      Easy: res?.easySolved?.total ?? 0,
      Medium: res?.mediumSolved?.total ?? 0,
      Hard: res?.hardSolved?.total ?? 0
    };
    console.log('[Accuracy] Fetched totalsByDiff:', totals);
    console.log('[Accuracy] Fetched solvedByDiff:', solved);
    return { totals, solved };
  } catch (e) {
    console.error('Failed to fetch difficulty totals/solved via questionList:', e);
    return null;
  }
}

// --- Function to fetch all submissions ---
async function fetchAllSubmissions() {
    const query = `
      query getSubmissionList($offset: Int!, $limit: Int!, $questionSlug: String) {
        submissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
          hasNext
          submissions {
            id
            title
            titleSlug
            status
            lang
            timestamp
          }
        }
      }
    `;
    let allSubmissions = [];
    let offset = 0;
    const limit = 20; // LeetCode's typical limit per page for submissions
    while (true) {
        const variables = { offset, limit, questionSlug: null };
        const data = await fetchLeetCodeGraphQL(query, variables);
        const submissions = data.data.submissionList.submissions;
        const hasNext = data.data.submissionList.hasNext;

        if (submissions) {
            allSubmissions = allSubmissions.concat(submissions);
        }
        
        if (!hasNext) break;
        offset += limit;
        await new Promise(r => setTimeout(r, 200));
    }
    await chrome.storage.local.set({ allSubmissions: allSubmissions });
    return allSubmissions;
}

// --- Function to fetch current user's username ---
async function fetchCurrentUsername() {
  const query = `
    query userStatus {
      userStatus {
        username
        isSignedIn
      }
    }
  `;
  const data = await fetchLeetCodeGraphQL(query, {});
  if (data && data.data && data.data.userStatus && data.data.userStatus.isSignedIn) {
    return data.data.userStatus.username;
  }
  return null;
}

// Helper to fetch per-topic (knowledge) solved/total and store to chrome.storage
async function fetchUserTopicProgress() {
  const query = `
    query userProgressKnowledgeList {
      userProgressKnowledgeList {
        progressKnowledgeInfo {
          finishedNum
          totalNum
          knowledgeTag { slug name nameTranslated }
        }
      }
    }
  `;
  const resp = await fetchLeetCodeGraphQL(query, {});
  const infos = resp?.data?.userProgressKnowledgeList?.progressKnowledgeInfo || [];
  return infos.map(i => ({
    slug: i.knowledgeTag?.slug,
    name: i.knowledgeTag?.name,
    finishedNum: i.finishedNum || 0,
    totalNum: i.totalNum || 0,
  })).filter(i => i.slug);
}

async function updateUserTopicProgressForTags(topicTags) {
  try {
    const all = await fetchUserTopicProgress();
    const neededSlugs = new Set(topicTags.map(t => t.slug));
    const toStore = {};
    all.forEach(i => {
      if (neededSlugs.has(i.slug)) {
        toStore[`tagTotal_${i.slug}`] = i.totalNum;
        toStore[`tagSolved_${i.slug}`] = i.finishedNum;
      }
    });
    if (Object.keys(toStore).length > 0) {
      await new Promise(resolve => chrome.storage.local.set(toStore, resolve));
    }
  } catch (e) {
    console.warn('Failed to update user topic progress:', e);
  }
}

let tagTotalsForDisplay = [];
let avgTagScoreForCurrentProblem = 0;
if (probData.topicTags.length > 0) {
  let aiCombos = [];
  try {
    aiCombos = await fetchTagCombinationsFromAI(probData.title, probData.topicTags.map(t => t.name));
    console.log("AI combos fetched:", aiCombos);
      // --- Add this ---
  const userTagProgress = await fetchUserTopicProgress();
   tagTotalsForDisplay = userTagProgress.map(i => ({
    name: i.name,
    slug: i.slug,
    total: i.totalNum,
    solved: i.finishedNum
  }));

  } catch (err) {
    console.warn("Failed to fetch AI tag combinations:", err);
  }

// --- Core Calculation Logic (Moved from popup.js, slightly adapted) ---
async function calculateAndDisplayAccuracy() {
  console.log('Starting accuracy calculation...');
  const currentProblemSlug = getCurrentProblemDetailsFromURL();
  if (!currentProblemSlug) {
    console.log("Not on a problem page. Skipping accuracy display.");
    return;
  }

  // --- User Session Management ---
  const currentUser = await fetchCurrentUsername();
  const storageItems = await chrome.storage.local.get(['lastLoggedInUser', 'allSubmissions', 'problemDetailsCache']);
  const lastLoggedInUser = storageItems.lastLoggedInUser;
  let allSubmissionsRaw = storageItems.allSubmissions || [];
  let problemDetailsCache = storageItems.problemDetailsCache || {};

  if (currentUser && lastLoggedInUser !== currentUser) {
    console.log(`User changed from ${lastLoggedInUser || 'None'} to ${currentUser}. Clearing stored data.`);
    // Clear all data associated with the previous user
    await chrome.storage.local.remove(['allSubmissions', 'problemDetailsCache']);
    allSubmissionsRaw = []; // Reset in-memory data
    problemDetailsCache = {}; // Reset in-memory data
    await chrome.storage.local.set({ lastLoggedInUser: currentUser }); // Store the new user
  } else if (!currentUser && lastLoggedInUser) {
    console.log(`User logged out. Clearing stored data.`);
    await chrome.storage.local.remove(['allSubmissions', 'problemDetailsCache', 'lastLoggedInUser']);
    allSubmissionsRaw = [];
    problemDetailsCache = {};
  } else if (currentUser && !lastLoggedInUser) {
    console.log(`First login detected for ${currentUser}. Storing username.`);
    await chrome.storage.local.set({ lastLoggedInUser: currentUser });
  }
  // --- End User Session Management ---

  // Fetch current problem details
  const problemQuery = `
    query getQuestionDetail($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        title
        titleSlug
        difficulty
        topicTags { name slug }
      }
    }
  `;
  let probData = null;
  try {
    const resp = await fetchLeetCodeGraphQL(problemQuery, { titleSlug: currentProblemSlug });
    probData = resp.data.question;
    if (!probData) {
      console.error("Could not fetch current problem data.", resp);
      return;
    }
  } catch (err) {
    console.error("Error fetching current problem details:", err);
    return;
  }

  // Fetch all submissions (only if needed)
  // allSubmissionsRaw is already loaded from storage or cleared by session management
  if (allSubmissionsRaw.length === 0 && currentUser) { // Only fetch if no data and a user is logged in
    console.log("No submissions found in storage for current user. Fetching all submissions...");
    allSubmissionsRaw = await fetchAllSubmissions();
    if (allSubmissionsRaw.length === 0) {
      console.log("No submissions fetched. Cannot calculate accuracy.");
      return;
    }
  } else if (!currentUser) {
    console.log("User not logged in. Cannot fetch submissions or calculate accuracy.");
    return;
  }

  // Fetch and cache problem details for submitted problems (only if needed)
  const uniqueSlugs = [...new Set(allSubmissionsRaw.map(s => s.titleSlug))];
  // Filter slugs to fetch based on current problemDetailsCache
  const slugsToFetch = uniqueSlugs.filter(slug => !problemDetailsCache[slug]);

  if (slugsToFetch.length > 0) {
    console.log(`Fetching details for ${slugsToFetch.length} new problems...`);
    problemDetailsCache = await fetchAndCacheProblemDetailsForSlugs(slugsToFetch); // This function now returns the updated cache
  }

  // Prepare submissions data with full problem details
  const submissions = allSubmissionsRaw.map(s => {
    const problemDetail = problemDetailsCache[s.titleSlug];
    if (!problemDetail) {
      console.warn(`Details missing for slug: ${s.titleSlug}. Skipping this submission.`);
      return null; // Skip submissions for which we couldn't fetch details
    }
    return {
      problem: s.titleSlug,
      tags: problemDetail.topicTags.map(t => t.name),
      difficulty: problemDetail.difficulty,
      status: s.status === 10 ? "AC" : "WA"
    };
  }).filter(s => s !== null);

  if (submissions.length === 0) {
    console.log("No valid submissions with problem details to calculate accuracy.");
    // If no submissions, we still might want to show some probability based on global stats or user can fetch later
    // For now, we will return. Can be improved.
    return;
  }

  // --- Calculation Functions ---

  function calculateStats(submissions) { // Removed totalProblemsByTag, totalProblemsByDifficulty
    const tagStats = {};
    const diffStats = {};

    // To track uniqueness
    const attemptedProblemsTag = {};
    const solvedProblemsTag = {};
    const attemptedProblemsDiff = {};
    const solvedProblemsDiff = {};

    submissions.forEach(sub => {
      const { problem, status, tags, difficulty } = sub;

      // ---------- TAG STATS ----------
      tags.forEach(tag => {
        if (!tagStats[tag]) {
          tagStats[tag] = { attempted: 0, solved: 0, totalSubs: 0, correctSubs: 0 };
          attemptedProblemsTag[tag] = new Set();
          solvedProblemsTag[tag] = new Set();
        }

        tagStats[tag].totalSubs++;
        if (status === "AC") tagStats[tag].correctSubs++;

        attemptedProblemsTag[tag].add(problem);
        if (status === "AC") solvedProblemsTag[tag].add(problem);
      });

      // ---------- DIFFICULTY STATS ----------
      if (!diffStats[difficulty]) {
        diffStats[difficulty] = { attempted: 0, solved: 0, totalSubs: 0, correctSubs: 0 };
        attemptedProblemsDiff[difficulty] = new Set();
        solvedProblemsDiff[difficulty] = new Set();
      }

      diffStats[difficulty].totalSubs++;
      if (status === "AC") diffStats[difficulty].correctSubs++;

      attemptedProblemsDiff[difficulty].add(problem);
      if (status === "AC") solvedProblemsDiff[difficulty].add(problem);
    });

    // Fill attempted & solved counts
    for (let tag in tagStats) {
      tagStats[tag].attempted = attemptedProblemsTag[tag].size;
      tagStats[tag].solved = solvedProblemsTag[tag].size;
    }

    for (let diff in diffStats) {
      diffStats[diff].attempted = attemptedProblemsDiff[diff].size;
      diffStats[diff].solved = solvedProblemsDiff[diff].size;
    }

    return { tagStats, diffStats };
  }

  function computeScores(tagStats, diffStats, alpha = 0.6, globalTotalsByDiff = null, globalSolvedByDiff = null) { // Removed totalProblemsByTag, totalProblemsByDifficulty
    const tagScores = {};
    const diffScores = {};

    for (let tag in tagStats) {
      const fam = tagStats[tag].attempted > 0 ? tagStats[tag].solved / tagStats[tag].attempted : 0;
      const cov = tagStats[tag].attempted > 0 ? 1 : 0; // Simplified coverage (display adjusted later)
      const acc = tagStats[tag].totalSubs > 0 ? tagStats[tag].correctSubs / tagStats[tag].totalSubs : 0;
      // Get global totals for this tag
      const totals = tagTotalsForDisplay.find(t => t.name === tag);
      const completion = totals && totals.total > 0 ? totals.solved / totals.total : 0;

      tagScores[tag] = {
        familiarity: fam,
        coverage: completion,
        accuracy: acc,
        score: alpha * fam + (1 - alpha) * cov
      };
    }

    // Difficulty coverage per rules using totals and solved from questionList if available:
    const totalE = (globalTotalsByDiff && typeof globalTotalsByDiff.Easy === 'number') ? globalTotalsByDiff.Easy : 0;
    const totalM = (globalTotalsByDiff && typeof globalTotalsByDiff.Medium === 'number') ? globalTotalsByDiff.Medium : 0;
    const totalH = (globalTotalsByDiff && typeof globalTotalsByDiff.Hard === 'number') ? globalTotalsByDiff.Hard : 0;

    const solvedE_ext = (globalSolvedByDiff && typeof globalSolvedByDiff.Easy === 'number') ? globalSolvedByDiff.Easy : null;
    const solvedM_ext = (globalSolvedByDiff && typeof globalSolvedByDiff.Medium === 'number') ? globalSolvedByDiff.Medium : null;
    const solvedH_ext = (globalSolvedByDiff && typeof globalSolvedByDiff.Hard === 'number') ? globalSolvedByDiff.Hard : null;

    // Fallback to local diffStats solved counts if external solved unavailable
    const solvedE_local = (diffStats.Easy && typeof diffStats.Easy.solved === 'number') ? diffStats.Easy.solved : 0;
    const solvedM_local = (diffStats.Medium && typeof diffStats.Medium.solved === 'number') ? diffStats.Medium.solved : 0;
    const solvedH_local = (diffStats.Hard && typeof diffStats.Hard.solved === 'number') ? diffStats.Hard.solved : 0;

    const solvedE = (solvedE_ext != null) ? solvedE_ext : solvedE_local;
    const solvedM = (solvedM_ext != null) ? solvedM_ext : solvedM_local;
    const solvedH = (solvedH_ext != null) ? solvedH_ext : solvedH_local;

    const difficulties = ['Easy', 'Medium', 'Hard'];
    difficulties.forEach(d => {
      const fam = diffStats[d]?.attempted > 0 ? diffStats[d].solved / diffStats[d].attempted : 0;
      const acc = diffStats[d]?.totalSubs > 0 ? diffStats[d].correctSubs / diffStats[d].totalSubs : 0;
      let cov = 0;
      if (d === 'Easy') {
        const num = solvedE + solvedM + solvedH;
        const den = totalE + totalM + totalH;
        cov = den > 0 ? Math.min(1, Math.max(0, num / den)) : 0;
      } else if (d === 'Medium') {
        const num = solvedM + solvedH;
        const den = totalM + totalH;
        cov = den > 0 ? Math.min(1, Math.max(0, num / den)) : 0;
      } else if (d === 'Hard') {
        const num = solvedH;
        const den = totalH;
        cov = den > 0 ? Math.min(1, Math.max(0, num / den)) : 0;
      }

      diffScores[d] = {
        familiarity: fam,
        coverage: cov,
        accuracy: acc,
        score: alpha * fam + (1 - alpha) * cov
      };
    });

    return { tagScores, diffScores };
  }

  // Main calculation steps:

  const { tagStats, diffStats } = calculateStats(submissions);


  // Ensure we have global difficulty totals and solved counts
  // Always fetch fresh to avoid stale cache affecting calculations
  let fetchedTotalsSolved = await updateGlobalDifficultyTotalsAndSolved();
  let globalTotalsByDiff = fetchedTotalsSolved ? fetchedTotalsSolved.totals : { Easy: 0, Medium: 0, Hard: 0 };
  let globalSolvedByDiff = fetchedTotalsSolved ? fetchedTotalsSolved.solved : { Easy: 0, Medium: 0, Hard: 0 };

  const { tagScores, diffScores } = computeScores(tagStats, diffStats, 0.6, globalTotalsByDiff, globalSolvedByDiff);

  const allSolvedCount = new Set(submissions.filter(s => s.status === "AC").map(s => s.problem)).size;
  const allAttemptedCount = new Set(submissions.map(s => s.problem)).size;
  const allWrongCount = submissions.filter(s => s.status !== "AC").length;

  const myAccAdj = ((allSolvedCount + 1) / (allAttemptedCount + 2)); // Simple Acceptance rate with smoothing

  const currentProblemTags = probData.topicTags.map(t => t.name);
  const currentProblemDifficulty = probData.difficulty;


  const validCombos = (aiCombos || []).filter(c => Array.isArray(c) && c.length > 0);
  if (validCombos.length > 0) {
    const comboScores = validCombos.map(c => computeComboScoreWithOriginalFormula(c, tagStats, tagTotalsForDisplay));
    avgTagScoreForCurrentProblem = Math.max(...comboScores); // pick the best combo
  } else {
    // fallback to simple average over all tags (your original method)
    // fallback to simple average over all tags
    let sumScores = 0;
    for (const t of probData.topicTags) {
        const stats = tagStats[t.name] || { attempted: 0, solved: 0 };
        const fam = stats.attempted > 0 ? stats.solved / stats.attempted : 0;
        const acc = stats.totalSubs > 0 ? stats.correctSubs / stats.totalSubs : 0;

        // --- NEW: Fetch global total and user solved for this tag ---
        const globalTotal = await fetchGlobalProblemsByTag(t.slug); // returns total problems for this tag
        const userSolved = stats.solved;
        const solvedRatio = globalTotal > 0 ? userSolved / globalTotal : 0;

        // --- Combine factors ---
        const alpha = 0.5; // familiarity weight
        const beta = 0.3;  // solved/global weight
        const gamma = 0.2; // accuracy weight
        const score = alpha * fam + beta * solvedRatio + gamma * acc;

        sumScores += score;
    }

    avgTagScoreForCurrentProblem = sumScores / probData.topicTags.length;

  }
}

  
 
  const overallDifficultyScoreForCurrentProblem = diffScores[currentProblemDifficulty]?.score || 0;

  const W1 = 0.4, W2 = 0.4, W3 = 0.2; // Adjusted weights

  const P = W1 * avgTagScoreForCurrentProblem +
            W2 * overallDifficultyScoreForCurrentProblem +
            W3 * myAccAdj;

  // --- UI Injection (Simplified for direct console log for now) ---
  const result = {
    problem: { title: probData.title, slug: probData.titleSlug, difficulty: currentProblemDifficulty, tags: currentProblemTags },
    overallSummary: {
        solvedProblems: allSolvedCount,
        attemptedProblems: allAttemptedCount,
        wrongSubmissions: allWrongCount,
        myAcceptanceAdjusted: myAccAdj.toFixed(3)
    },
    tagPerformance: Object.keys(tagScores)
        .filter(tag => currentProblemTags.includes(tag))
        .map(tag => {
            const fam = tagScores[tag].familiarity;
            const acc = tagScores[tag].accuracy;
            const fromTotals = (tagTotalsForDisplay || []).find(t => t.name === tag);
            let cov;
            if (fromTotals && typeof fromTotals.total === 'number' && fromTotals.total > 0 && typeof fromTotals.solved === 'number') {
              cov = Math.min(1, Math.max(0, fromTotals.solved / fromTotals.total));
            } else {
              // fallback to previous simple coverage if totals unavailable
              cov = tagScores[tag].coverage;
            }
            const alphaForTagScore = 0.6;
            const sc = alphaForTagScore * fam + (1 - alphaForTagScore) * cov;
            return {
              tag,
              familiarity: fam.toFixed(3),
              coverage: cov.toFixed(3),
              accuracy: acc.toFixed(3),
              score: sc.toFixed(3)
            };
        }).sort((a, b) => b.score - a.score), 
    difficultyPerformance: Object.keys(diffScores).map(diff => ({
      difficulty: diff,
      familiarity: diffScores[diff].familiarity.toFixed(3),
      coverage: diffScores[diff].coverage.toFixed(3),
      accuracy: diffScores[diff].accuracy.toFixed(3),
      score: diffScores[diff].score.toFixed(3)
    })).sort((a, b) => b.score - a.score),
    calculatedScoresForCurrentProblem: {
        avgTagScore: avgTagScoreForCurrentProblem.toFixed(3),
        overallDifficultyScore: overallDifficultyScoreForCurrentProblem.toFixed(3)
    },
    tagTotals: tagTotalsForDisplay,
    probability: (P * 100).toFixed(2) + "%"
  };

  // Print topic totals to console (DevTools)
  const tagTotalsConsoleText = (tagTotalsForDisplay || [])
    .filter(t => typeof t.total === 'number' && typeof t.solved === 'number')
    .map(t => {
      const parts = [`${t.name}: ${t.solved}/${t.total}`];
      const d = t.byDiff || {};
      const fmt = (x) => typeof x === 'number' ? x : 0;
      if (d.Easy || d.Medium || d.Hard) {
        const e = d.Easy || {}; const m = d.Medium || {}; const h = d.Hard || {};
        parts.push(`(E ${fmt(e.solved)}/${fmt(e.total)} • M ${fmt(m.solved)}/${fmt(m.total)} • H ${fmt(h.solved)}/${fmt(h.total)})`);
      }
      return parts.join(' ');
    })
    .join(' | ');
  if (tagTotalsConsoleText) {
    console.log(`Topic totals: ${tagTotalsConsoleText}`);
  } else {
    console.log('Topic totals: none available (use the popup to fetch tag problems for these topics).');
  }

  // Inject the result directly into the LeetCode page DOM
  const problemTitleContainer = document.querySelector('div.text-title-large');
  if (problemTitleContainer) {
    const problemLinkElement = problemTitleContainer.querySelector('a');
    if (problemLinkElement) {
      let probDisplay = document.getElementById('leetcode-accuracy-probability');
      if (!probDisplay) {
        probDisplay = document.createElement('span');
        probDisplay.id = 'leetcode-accuracy-probability';
        probDisplay.style.marginLeft = '10px';
        probDisplay.style.fontWeight = 'normal'; // Made thinner
        probDisplay.style.fontSize = '18px'; // Made smaller
        probDisplay.style.color = '#fac31d'; // LeetCode yellow
        probDisplay.title = "This is your probability of solving this problem."; // Tooltip text
        problemLinkElement.parentNode.insertBefore(probDisplay, problemLinkElement.nextSibling);
      }
      probDisplay.textContent = `${result.probability}`;

    } else {
      console.warn("Could not find the problem link element within the title container.");
    }
  } else {
    console.warn("Could not find problem title container element to inject probability.");
  }

  console.log("Accuracy Calculation Result:", result);
  console.log("Note: Accuracy is based on your submitted problems' history only. 'Coverage' metrics assume you've attempted all problems in a category since global problem counts are not used.");
}

function parseAIResponse(rawText) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.replace(/^```json\s*/, '');
  if (cleaned.endsWith("```")) cleaned = cleaned.replace(/```$/, '');
  return JSON.parse(cleaned);
}

async function fetchTagCombinationsFromAI(problemName, tags) {
  const prompt = `
Problem: "${problemName}"
Tags: [${tags.map(t => `"${t}"`).join(", ")}]

Suggest all useful tag combinations a user can solve this problem with.
Include single tags and multiple-tag combinations.
Return ONLY as a JSON array of arrays. Example:
[["arrays"], ["arrays", "sliding window"], ["arrays","hashtable"]]
`;

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ai_prompt', prompt }, (response) => {
      if (!response?.success) return reject(new Error(response?.error || "Unknown AI error"));

      try {
        let rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        // Remove code block wrappers
        rawText = rawText.replace(/```json\s*|```/g, '').trim();
        const combos = JSON.parse(rawText);
        if (!Array.isArray(combos)) return resolve([]);
        resolve(combos);
      } catch (err) {
        console.warn("AI response parse failed, returning empty array:", err);
        resolve([]); // fallback to empty array
      }
    });
  });
}


function computeComboScoreWithOriginalFormula(combo, tagStats, tagTotals) {
  if (!Array.isArray(combo) || combo.length === 0) return 0;

  const alpha = 0.6; // same as your original tag weighting
  const scoreSum = combo.reduce((sum, tag) => {
    const stats = tagStats[tag] || { attempted: 0, solved: 0 };
    const totals = tagTotals.find(t => t.name === tag);
    let cov = 0;
    if (totals && totals.total > 0) {
      cov = Math.min(1, Math.max(0, totals.solved / totals.total));
    } else {
      cov = stats.attempted > 0 ? 1 : 0;
    }
    const fam = stats.attempted > 0 ? stats.solved / stats.attempted : 0;
    return sum + (alpha * fam + (1 - alpha) * cov);
  }, 0);

  return scoreSum / combo.length;
}




function calculateComboScore(combo, tagStats, alpha = 0.6) {
  if (!Array.isArray(combo) || combo.length === 0) return 0;
  const total = combo.reduce((sum, tag) => {
    const stats = tagStats[tag] || { attempted: 0, solved: 0 };
    const fam = stats.attempted > 0 ? stats.solved / stats.attempted : 0;
    const cov = stats.attempted > 0 ? 1 : 0;
    return sum + (alpha * fam + (1 - alpha) * cov);
  }, 0);
  return total / combo.length;
}

async function fetchGlobalProblemsByTag(tagSlug) {
  try {
    const query = `
      query problemsetQuestionList($filters: QuestionFilterInput, $limit: Int) {
        problemsetQuestionList(
          limit: $limit
          filters: $filters
        ) {
          total
        }
      }
    `;
    const variables = { filters: { topicSlugs: [tagSlug] }, limit: 1 }; // limit=1, we just need total
    const resp = await fetchLeetCodeGraphQL(query, variables);
    const total = resp?.data?.problemsetQuestionList?.total || 0;
    return total;
  } catch (err) {
    console.warn(`Failed to fetch global problem total for tag ${tagSlug}:`, err);
    return 0;
  }
}
async function fetchUserAttemptedSolvedByTag(tagSlug) {
  try {
    const infos = await fetchUserTopicProgress(); // already defined in your code
    const tagInfo = infos.find(i => i.slug === tagSlug);
    if (!tagInfo) return { solved: 0, totalAttempted: 0 };
    return { solved: tagInfo.finishedNum, totalAttempted: tagInfo.totalNum };
  } catch (err) {
    console.warn(`Failed to fetch user progress for tag ${tagSlug}:`, err);
    return { solved: 0, totalAttempted: 0 };
  }
}


// --- Auto-trigger on page load ---
// Check if on a problem page and trigger calculation
const currentProblemSlug = getCurrentProblemDetailsFromURL();
if (currentProblemSlug) {
  console.log(`Content script on problem page: ${currentProblemSlug}. Triggering auto-calculation.`);
  calculateAndDisplayAccuracy();
}

console.log("Content script ready."); 