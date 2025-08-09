// content.js

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

  // Specific check for problemsetQuestionList, might be null if no data
  if (query.includes("problemsetQuestionList") && (!jsonResponse.data || !jsonResponse.data.questions)) {
      console.error("Unexpected GraphQL data structure for problemsetQuestionList:", jsonResponse);
      throw new Error("Unexpected GraphQL response structure. Missing data.data.questions for problemsetQuestionList.");
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
    return;
  }

  // --- Calculation Functions (copied from your example) ---
  const alpha = 0.7;
  const beta = 0.7;
  const gamma = 0.5;
  const W1 = 0.4, W2 = 0.4, W3 = 0.2;
  const smoothing = 1;

  function uniqueProblems(data) {
      return [...new Set(data.map(d => d.problem))];
  }

  function getTagDifficultyStats(subs) {
      const stats = {};
      subs.forEach(s => {
          s.tags.forEach(tag => {
              const key = `${tag}_${s.difficulty}`;
              if (!stats[key]) stats[key] = { solved: new Set(), attempted: new Set(), wrong: 0 };
              stats[key].attempted.add(s.problem);
              if (s.status === "AC") stats[key].solved.add(s.problem);
              else stats[key].wrong++;
          });
      });
      return stats;
  }

  function calcCombinedScore(stat) {
      const solved = stat.solved.size;
      const attempted = stat.attempted.size;
      const attempt_fam = attempted ? solved / attempted : 0;
      const coverage = 1; 
      return alpha * attempt_fam + (1 - alpha) * coverage;
  }

  function getDiffStats(subs) {
      const stats = {};
      subs.forEach(s => {
          if (!stats[s.difficulty]) stats[s.difficulty] = { solved: new Set(), attempted: new Set(), wrong: 0 };
          stats[s.difficulty].attempted.add(s.problem);
          if (s.status === "AC") stats[s.difficulty].solved.add(s.problem);
          else stats[s.difficulty].wrong++;
      });
      return stats;
  }

  function calcDiffScore(diffStat) {
      const solved = diffStat.solved.size;
      const attempted = diffStat.attempted.size;
      const attempt_fam = attempted ? solved / attempted : 0;
      const coverage = 1;
      return beta * attempt_fam + (1 - beta) * coverage;
  }

  function calcMyAcceptance(totalSolved, totalAttempted, totalWrong) {
      const myAcc = (totalSolved + smoothing) / (totalAttempted + 2 * smoothing);
      const avgWrong = totalAttempted ? totalWrong / totalAttempted : 0;
      const penalty = 1 / (1 + gamma * avgWrong);
      return myAcc * penalty;
  }
  // --- End of Calculation Functions ---

  const tagDifficultyStats = getTagDifficultyStats(submissions);
  const combinedScores = {};
  for (const key in tagDifficultyStats) {
      combinedScores[key] = calcCombinedScore(tagDifficultyStats[key]);
  }

  const diffStats = getDiffStats(submissions);
  const diffScoresCalculated = {};
  for (const diff in diffStats) {
      diffScoresCalculated[diff] = calcDiffScore(diffStats[diff]);
  }

  const allSolvedCount = uniqueProblems(submissions.filter(s => s.status === "AC")).length;
  const allAttemptedCount = uniqueProblems(submissions).length;
  const allWrongCount = submissions.filter(s => s.status !== "AC").length;
  const myAccAdj = calcMyAcceptance(allSolvedCount, allAttemptedCount, allWrongCount);

  const currentProblemTags = probData.topicTags.map(t => t.name);
  const currentProblemDifficulty = probData.difficulty;

  let avgTagDifficultyScoreForCurrentProblem = 0;
  if (currentProblemTags.length > 0) {
      let sumScores = 0;
      currentProblemTags.forEach(tag => {
          const key = `${tag}_${currentProblemDifficulty}`;
          sumScores += (combinedScores[key] || 0);
      });
      avgTagDifficultyScoreForCurrentProblem = sumScores / currentProblemTags.length;
  }

  const overallDifficultyScoreForCurrentProblem = diffScoresCalculated[currentProblemDifficulty] || 0;

  const P = W1 * avgTagDifficultyScoreForCurrentProblem +
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
    tagDifficultyPerformance: Object.keys(tagDifficultyStats)
        .filter(key => {
            const [tag, diff] = key.split('_');
            return currentProblemTags.includes(tag) && diff === currentProblemDifficulty;
        })
        .map(key => {
            const [tag, difficulty] = key.split('_');
            const stat = tagDifficultyStats[key];
            return {
                tag,
                difficulty,
                solved: stat.solved.size,
                attempted: stat.attempted.size,
                wrong: stat.wrong,
                score: calcCombinedScore(stat).toFixed(3)
            };
        }).sort((a, b) => b.score - a.score),
    difficultyPerformance: Object.keys(diffStats).map(diff => ({
      difficulty: diff,
      solved: diffStats[diff].solved.size,
      attempted: diffStats[diff].attempted.size,
      wrong: diffStats[diff].wrong,
      score: diffScoresCalculated[diff].toFixed(3)
    })).sort((a, b) => b.score - a.score),
    calculatedScoresForCurrentProblem: {
        avgTagDifficultyScore: avgTagDifficultyScoreForCurrentProblem.toFixed(3),
        overallDifficultyScore: overallDifficultyScoreForCurrentProblem.toFixed(3)
    },
    probability: (P * 100).toFixed(2) + "%"
  };

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

// --- Message Listener from Popup (mostly for initial manual trigger/debugging) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === "getUserStats") {
      // This action now primarily used for getting username, if needed by popup
      const username = await fetchCurrentUsername();
      if (username) {
        // You could also store username in storage here if needed for other parts
        sendResponse({ success: true, data: { username: username } });
      } else {
        sendResponse({ success: false, error: "Not signed in to LeetCode." });
      }
    } else if (message.action === "getAllProblems") {
      // This is no longer primarily used, as problem details are fetched on demand.
      // But if user clicks it, we can fetch all for debugging/display.
      console.warn("'Fetch All Problems' button is deprecated in this version. Not fetching all problems.");
      sendResponse({ success: true, data: { total: 0, questions: [] } });
    } else if (message.action === "getRecentAccepted") {
      // This is also deprecated for core calculation, as we use getAllSubmissions.
      console.warn("'Fetch Recent ACs' button is deprecated in this version. Not fetching recent ACs.");
      sendResponse({ success: true, data: { data: { recentAcSubmissionList: [] } } });
    } else if (message.action === "getAllSubmissions") {
      try {
        console.log("Fetching all submissions via popup request...");
        const submissions = await fetchAllSubmissions();
        sendResponse({ success: true, data: submissions });
      } catch (err) {
        console.error("Error fetching all submissions from content script:", err);
        sendResponse({ success: false, error: String(err) });
      }
    } else if (message.action === "getCurrentProblemDetails") {
      // This action is now handled internally by calculateAndDisplayAccuracy
      const titleSlug = getCurrentProblemDetailsFromURL();
      if (titleSlug) {
        try {
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
          const data = await fetchLeetCodeGraphQL(query, { titleSlug });
          sendResponse({ success: true, data });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      } else {
        sendResponse({ success: false, error: "Not on a problem page." });
      }
    } else if (message.action === "calculateProbability") {
      // Trigger calculation from popup
      calculateAndDisplayAccuracy();
      sendResponse({ success: true });
    }
  })();
  return true;
});

// --- Auto-trigger on page load ---
// Check if on a problem page and trigger calculation
const currentProblemSlug = getCurrentProblemDetailsFromURL();
if (currentProblemSlug) {
  console.log(`Content script on problem page: ${currentProblemSlug}. Triggering auto-calculation.`);
  calculateAndDisplayAccuracy();
}

console.log("Content script ready."); 