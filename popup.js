// popup.js
// Communicate with content script and chrome.storage to fetch data and compute probability.

function log(msg) {
  document.getElementById("output").textContent = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
}

function sendToActiveTab(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return reject("No active tab");
      const tab = tabs[0];
      // Ensure we only talk to LeetCode pages
      if (!tab.url || !tab.url.startsWith("https://leetcode.com")) {
        return reject("Please open a LeetCode page (https://leetcode.com) in the active tab and refresh if needed.");
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError.message);
        }
        resolve(response);
      });
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  log("Attempting to fetch username and stats automatically...");
  try {
    const usernameResp = await sendToActiveTab({ action: "getUserStats" });
    if (usernameResp.success && usernameResp.data && usernameResp.data.username) {
      log(`Logged in as: ${usernameResp.data.username}. Fetching submissions...`);
      const submissionsResp = await sendToActiveTab({ action: "getAllSubmissions" });
      if (submissionsResp.success) {
        log(`Fetched ${submissionsResp.data.length} total submissions. Calculating probability...`);
        const calcResp = await sendToActiveTab({ action: "calculateProbability" });
        if (calcResp.success) {
          // Result will be logged by content.js, so just indicate success here
          log("Probability calculation initiated. Check output below.");
        } else {
          log("Error initiating calculation: " + JSON.stringify(calcResp));
        }
      } else {
        log("Error fetching submissions: " + JSON.stringify(submissionsResp));
      }
    } else {
      log("Error: Not signed in or could not retrieve username. " + JSON.stringify(usernameResp));
    }
  } catch (err) {
    log("Error during auto-fetch/calc: " + String(err));
  }
});

const tagSlugInput = document.getElementById("tagSlugInput");
const btnFetchTagProblems = document.getElementById("btnFetchTagProblems");
const tagStatsOutput = document.getElementById("tagStatsOutput");

btnFetchTagProblems.addEventListener("click", async () => {
  const tagSlug = tagSlugInput.value.trim();
  if (!tagSlug) {
    tagStatsOutput.textContent = "Please enter a tag slug.";
    return;
  }

  tagStatsOutput.textContent = `Fetching problems for tag: ${tagSlug}...`;
  try {
    const resp = await sendToActiveTab({ action: "GET_TAG_PROBLEMS", tagSlug: tagSlug });
    if (resp.success) {
      const totalProblemsInTag = resp.data.totalLength;
      // We need to get user's solved problems for this tag.
      // This requires comparing fetched problems with user's submissions.
      const allSubmissionsRaw = (await chrome.storage.local.get(["allSubmissions"])).allSubmissions || [];
      const problemDetailsCache = (await chrome.storage.local.get(["problemDetailsCache"])).problemDetailsCache || {};

      const solvedProblemsInTag = new Set();
      resp.data.questions.forEach(tagProblem => {
        // Check if the user has an AC submission for this problem
        const isSolved = allSubmissionsRaw.some(submission => 
          submission.titleSlug === tagProblem.titleSlug && submission.status === 10 // 10 is AC status
        );
        if (isSolved) {
          solvedProblemsInTag.add(tagProblem.titleSlug);
        }
      });

      tagStatsOutput.textContent = `Tag: ${tagSlug} | Solved: ${solvedProblemsInTag.size} / Total: ${totalProblemsInTag}`;

      // Store this in local storage for the main calculation if needed
      await chrome.storage.local.set({ [`tagProblems_${tagSlug}`]: resp.data.questions });
      await chrome.storage.local.set({ [`tagTotal_${tagSlug}`]: totalProblemsInTag });
      await chrome.storage.local.set({ [`tagSolved_${tagSlug}`]: solvedProblemsInTag.size });

    } else {
      tagStatsOutput.textContent = "Error fetching tag problems: " + JSON.stringify(resp.error);
    }
  } catch (err) {
    tagStatsOutput.textContent = "Error: " + String(err);
  }
});

document.getElementById("btnFetchAllSubmissions").addEventListener("click", async () => {
  try {
    log("Fetching all submissions (may take a while if you have many)...");
    const resp = await sendToActiveTab({ action: "getAllSubmissions" });
    if (resp.success) {
      log(`Fetched ${resp.data.length} total submissions and saved to storage.`);
    } else {
      log("Error: " + JSON.stringify(resp));
    }
  } catch (err) { log("Error: " + err); }
});

/*
  Calculation logic:
  - We read:
    * problems => list of all problems with tags/difficulty
    * recentAccepted => list of recently accepted problems for the user (titleSlug)
    * userStats => counts by difficulty (for basic info)
  - With this base we compute:
    * coverage per tag (solved_in_tag / total_in_tag)
    * coverage per difficulty (solved_in_diff / total_in_diff)
    * TagScore = alpha * attempt_fam (not available) + (1 - alpha) * coverage; since attempt_fam per-tag requires full submission history,
      we fall back to using coverage for both attempt_fam and coverage in the first version. Marked places show where to improve later.
  - Final P = W1 * TagScore + W2 * DiffScore + W3 * MyAcceptanceAdj
*/
document.getElementById("btnCalculate").addEventListener("click", async () => {
  try {
    log("Calculating probability for current problem...");
    // get current problem details from content script
    const probResp = await sendToActiveTab({ action: "getCurrentProblemDetails" });
    if (!probResp.success) return log("Could not read problem details from the page. Open a /problems/<slug>/ page.");

    const probData = probResp.data.data.question;
    if (!probData) return log("Problem data missing.");

    // Load all submissions and problem details cache
    chrome.storage.local.get(["allSubmissions", "problemDetailsCache"], async (items) => {
      const allSubmissionsRaw = items.allSubmissions || [];
      let problemDetailsCache = items.problemDetailsCache || {};

      if (allSubmissionsRaw.length === 0) {
        log("Error: No submissions found. Please click 'Fetch All Submissions' first.");
        return;
      }

      // 1. Ensure all submitted problem details are fetched and cached
      const uniqueSlugs = [...new Set(allSubmissionsRaw.map(s => s.titleSlug))];
      const slugsToFetch = uniqueSlugs.filter(slug => !problemDetailsCache[slug]);

      if (slugsToFetch.length > 0) {
        log(`Fetching details for ${slugsToFetch.length} new problems... This might take a while.`);
        const resp = await sendToActiveTab({ action: "fetchAndCacheProblemDetailsForSlugs", slugs: slugsToFetch });
        if (resp.success) {
          problemDetailsCache = resp.data; // Update cache with newly fetched data
          log(`Fetched ${slugsToFetch.length} new problem details.`);
        } else {
          log("Error fetching problem details: " + JSON.stringify(resp));
          return;
        }
      }

      // 2. Prepare submissions data with full problem details
      const submissions = allSubmissionsRaw.map(s => {
        const problemDetail = problemDetailsCache[s.titleSlug];
        if (!problemDetail) {
          console.warn(`Details missing for slug: ${s.titleSlug}. Skipping this submission.`);
          return null; // Skip submissions for which we couldn't fetch details
        }
        return {
          problem: s.titleSlug, // Using titleSlug as problem identifier
          tags: problemDetail.topicTags.map(t => t.name),
          difficulty: problemDetail.difficulty,
          status: s.status === 10 ? "AC" : "WA" // Map LeetCode status code 10 to "AC", others to "WA"
        };
      }).filter(s => s !== null); // Remove any skipped submissions

      if (submissions.length === 0) {
        log("No valid submissions with problem details to calculate accuracy.");
        return;
      }

      // --- Your Calculation Functions (modified and integrated) ---
      const alpha = 0.7; // weight between attempt familiarity and coverage for tags
      const beta = 0.7;  // weight for difficulty score
      const gamma = 0.5; // penalty multiplier for wrong attempts
      const W1 = 0.4, W2 = 0.4, W3 = 0.2; // final combination weights
      const smoothing = 1; // Laplace smoothing

      function uniqueProblems(data) {
          return [...new Set(data.map(d => d.problem))];
      }

      // NEW: Count per (tag, difficulty) pair
      function getTagDifficultyStats(subs) {
          const stats = {}; // Key: "tag_difficulty" -> { solved: Set<problem>, attempted: Set<problem>, wrong: count }
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

      // NEW: Calculate score for a combined (tag, difficulty) stat
      function calcCombinedScore(stat, totalProblemsInTag) {
          const solved = stat.solved.size;
          const attempted = stat.attempted.size;
          const attempt_fam = attempted ? solved / attempted : 0;
          // Coverage is solved problems in tag / total problems in tag
          const coverage = (totalProblemsInTag > 0) ? (solved / totalProblemsInTag) : 0;
          
          return alpha * attempt_fam + (1 - alpha) * coverage;
      }

      // Existing: Count per difficulty (overall, from submitted problems)
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

      // Existing: Calculate difficulty score (overall, from submitted problems)
      function calcDiffScore(diffStat) {
          const solved = diffStat.solved.size;
          const attempted = diffStat.attempted.size;
          const attempt_fam = attempted ? solved / attempted : 0;
          // Coverage is 1 because we don't have global problem list
          const coverage = 1;
          return beta * attempt_fam + (1 - beta) * coverage;
      }

      // Existing: MyAcceptance with penalty
      function calcMyAcceptance(totalSolved, totalAttempted, totalWrong) {
          const myAcc = (totalSolved + smoothing) / (totalAttempted + 2 * smoothing);
          const avgWrong = totalAttempted ? totalWrong / totalAttempted : 0;
          const penalty = 1 / (1 + gamma * avgWrong);
          return myAcc * penalty;
      }
      // --- End of Your Calculation Functions ---

      // Main calculation steps:

      // 1. Get stats per (tag, difficulty) combination from user's submissions
      const tagDifficultyStats = getTagDifficultyStats(submissions);
      const combinedScores = {};
      for (const key in tagDifficultyStats) {
          const [tag, difficulty] = key.split('_');
          // We need to pass the total problems for this specific tag and difficulty
          // For simplicity, for now, we'll use the overall total problems for the CURRENTLY FETCHED tag
          // If the current problem's tag is the one we fetched, use its total.
          let totalForCoverage = 0;
          const fetchedTagSlug = tagSlugInput.value.trim();

          if (fetchedTagSlug === tag) {
              totalForCoverage = (await chrome.storage.local.get([`tagTotal_${fetchedTagSlug}`]))[`tagTotal_${fetchedTagSlug}`] || 0;
          } else {
              // Fallback to 1 if no specific tag total is available or it's not the current fetched tag
              // This means coverage will still be 1 for other tags not explicitly fetched/calculated.
              totalForCoverage = 1; // Or you could use a more robust fallback like average total problems per tag if available
          }

          combinedScores[key] = calcCombinedScore(tagDifficultyStats[key], totalForCoverage);
      }

      // 2. Get overall stats per difficulty from user's submissions
      const diffStats = getDiffStats(submissions);
      const diffScoresCalculated = {};
      for (const diff in diffStats) {
          diffScoresCalculated[diff] = calcDiffScore(diffStats[diff]);
      }

      // 3. Get overall personal acceptance stats from user's submissions
      const allSolvedCount = uniqueProblems(submissions.filter(s => s.status === "AC")).length;
      const allAttemptedCount = uniqueProblems(submissions).length;
      const allWrongCount = submissions.filter(s => s.status !== "AC").length;
      const myAccAdj = calcMyAcceptance(allSolvedCount, allAttemptedCount, allWrongCount);

      // 4. Predict probability for the *current* problem open on LeetCode
      const currentProblemTags = probData.topicTags.map(t => t.name);
      const currentProblemDifficulty = probData.difficulty;

      // W1: Average Tag-Difficulty Score for current problem's tags
      let avgTagDifficultyScoreForCurrentProblem = 0;
      if (currentProblemTags.length > 0) {
          const storageKeys = [];
          // Load totals/solved per tag for current problem's tags from storage
          probData.topicTags.forEach(t => {
            storageKeys.push(`tagTotal_${t.slug}`);
            storageKeys.push(`tagSolved_${t.slug}`);
          });
          const stored = await new Promise(resolve => {
            try {
              chrome.storage.local.get(storageKeys, (items) => resolve(items || {}));
            } catch (e) {
              resolve({});
            }
          });

          let sumScores = 0;
          probData.topicTags.forEach(t => {
            const tagName = t.name;
            const slug = t.slug;
            const key = `${tagName}_${currentProblemDifficulty}`;
            const stat = tagDifficultyStats[key] || { solved: new Set(), attempted: new Set(), wrong: 0 };

            const solvedCount = stat.solved.size;
            const attemptedCount = stat.attempted.size;
            const attemptFam = attemptedCount ? solvedCount / attemptedCount : 0;

            const total = stored[`tagTotal_${slug}`];
            let coverage;
            if (typeof total === 'number' && total > 0) {
              coverage = Math.min(1, solvedCount / total);
            } else {
              // Smoothed fallback to avoid overconfidence with very few attempts
              coverage = (attemptedCount + 2) > 0 ? (solvedCount + 1) / (attemptedCount + 2) : 0;
            }

            const score = alpha * attemptFam + (1 - alpha) * coverage;
            sumScores += score;
          });
          avgTagDifficultyScoreForCurrentProblem = sumScores / probData.topicTags.length;
      }

      // W2: Overall Difficulty Familiarity Score for current problem's difficulty
      const overallDifficultyScoreForCurrentProblem = diffScoresCalculated[currentProblemDifficulty] || 0;

      // Final weighted probability (P)
      const P = W1 * avgTagDifficultyScoreForCurrentProblem + 
                W2 * overallDifficultyScoreForCurrentProblem + 
                W3 * myAccAdj;

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
            }).sort((a, b) => b.score - a.score), // Sort by score for readability
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

      // Add tag-specific total and solved counts if available
      const fetchedTagSlug = tagSlugInput.value.trim();
      if (fetchedTagSlug) {
        const tagTotal = (await chrome.storage.local.get([`tagTotal_${fetchedTagSlug}`]))[`tagTotal_${fetchedTagSlug}`];
        const tagSolved = (await chrome.storage.local.get([`tagSolved_${fetchedTagSlug}`]))[`tagSolved_${fetchedTagSlug}`];
        if (tagTotal !== undefined && tagSolved !== undefined) {
          result.tagSpecificSummary = {
            tag: fetchedTagSlug,
            solvedProblems: tagSolved,
            totalProblems: tagTotal,
            calculatedCoverage: (tagTotal > 0) ? (tagSolved / tagTotal).toFixed(3) : "N/A"
          };
        }
      }

      let finalOutput = JSON.stringify(result, null, 2);
      finalOutput += "\n\nNote: Accuracy is based on your submitted problems' history only. 'Coverage' metrics assume you've attempted all problems in a category since global problem counts are not used.";
      log(finalOutput);
    });

  } catch (err) {
    log("Error during calculation: " + String(err));
  }
}); 