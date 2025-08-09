// popup.js

function log(msg) {
  document.getElementById("output").textContent = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
}

function sendToActiveTab(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return reject("No active tab");
      const tab = tabs[0];
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

document.getElementById("btnFetchAllSubmissions").addEventListener("click", async () => {
  try {
    log("Fetching all submissions (may take a while if you have many)...");
    const resp = await sendToActiveTab({ action: "getAllSubmissions" });
    if (resp.success) {
      log(`Fetched ${resp.data.length} total submissions and saved to storage.`);
    } else {
      log("Error: " + JSON.stringify(resp));
    }
  } catch (err) {
    log("Error: " + err);
  }
});

document.getElementById("btnCalculate").addEventListener("click", async () => {
  try {
    log("Calculating probability for current problem...");
    const probResp = await sendToActiveTab({ action: "getCurrentProblemDetails" });
    if (!probResp.success) {
      return log("Could not read problem details from the page. Open a /problems/<slug>/ page.");
    }
    const probData = probResp.data.data.question;
    if (!probData) return log("Problem data missing.");

    chrome.storage.local.get(["allSubmissions", "problemDetailsCache"], async (items) => {
      const allSubmissionsRaw = items.allSubmissions || [];
      let problemDetailsCache = items.problemDetailsCache || {};

      if (allSubmissionsRaw.length === 0) {
        log("Error: No submissions found. Please click 'Fetch All Submissions' first.");
        return;
      }

      const uniqueSlugs = [...new Set(allSubmissionsRaw.map(s => s.titleSlug))];
      const slugsToFetch = uniqueSlugs.filter(slug => !problemDetailsCache[slug]);

      if (slugsToFetch.length > 0) {
        log(`Fetching details for ${slugsToFetch.length} new problems... This might take a while.`);
        const resp = await sendToActiveTab({ action: "fetchAndCacheProblemDetailsForSlugs", slugs: slugsToFetch });
        if (resp.success) {
          problemDetailsCache = resp.data;
          log(`Fetched ${slugsToFetch.length} new problem details.`);
        } else {
          log("Error fetching problem details: " + JSON.stringify(resp));
          return;
        }
      }

      const submissions = allSubmissionsRaw.map(s => {
        const problemDetail = problemDetailsCache[s.titleSlug];
        if (!problemDetail) {
          console.warn(`Details missing for slug: ${s.titleSlug}. Skipping this submission.`);
          return null;
        }
        return {
          problem: s.titleSlug,
          tags: problemDetail.topicTags.map(t => t.name),
          difficulty: problemDetail.difficulty,
          status: s.status === 10 ? "AC" : "WA"
        };
      }).filter(s => s !== null);

      if (submissions.length === 0) {
        log("No valid submissions with problem details to calculate accuracy.");
        return;
      }

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

      let finalOutput = JSON.stringify(result, null, 2);
      finalOutput += "\n\nNote: Accuracy is based on your submitted problems' history only. 'Coverage' metrics assume you've attempted all problems in a category since global problem counts are not used.";
      log(finalOutput);
    });

  } catch (err) {
    log("Error during calculation: " + String(err));
  }
});
