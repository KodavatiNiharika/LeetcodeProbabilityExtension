// content.js
const LEETCODE_GRAPHQL = 'https://leetcode.com/graphql/';
const BATCH_SIZE = 100;

console.log('🚀 Script started');

// -------------------- Fetch Problems Batch --------------------
async function fetchProblems(skip = 0, limit = BATCH_SIZE) {
    const query = `
      query problemsetQuestionListV2($skip: Int, $limit: Int) {
        problemsetQuestionListV2(limit: $limit, skip: $skip, categorySlug: "all-code-essentials") {
          questions {
            titleSlug
            title
            acRate
            difficulty
            topicTags { name slug }
          }
          totalLength
          hasMore
        }
      }`;
    const variables = { skip, limit };

    try {
        const res = await fetch(LEETCODE_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': '*' },
            body: JSON.stringify({ query, variables }),
            credentials: 'include'
        });
        const data = await res.json();
        return data.data.problemsetQuestionListV2;
    } catch (err) {
        console.error('Error fetching problems:', err);
        return { questions: [], hasMore: false };
    }
}

// -------------------- Fetch User Progress --------------------
async function fetchUserTopicProgress() {
    const query = `
      query userProgressKnowledgeList {
        userProgressKnowledgeList {
          progressKnowledgeInfo {
            finishedNum
            totalNum
            knowledgeTag { slug name }
          }
        }
      }`;
    try {
        const res = await fetch(LEETCODE_GRAPHQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: {} }),
            credentials: 'include'
        });
        const data = await res.json();
        const infos = data?.data?.userProgressKnowledgeList?.progressKnowledgeInfo || [];
        return infos.map(i => ({
            slug: i.knowledgeTag?.slug,
            name: i.knowledgeTag?.name,
            finishedNum: i.finishedNum || 0,
            totalNum: i.totalNum || 0
        }));
    } catch (err) {
        console.warn('Error fetching user progress:', err);
        return [];
    }
}

// -------------------- Compute Base Probability --------------------
function computeBaseProbability(problem, userTagProgress) {
    const alpha = 0.5, beta = 0.3, gamma = 0.2;
    let famScore = 0;

    if (problem.topicTags?.length) {
        const scores = problem.topicTags.map(tag => {
            const progress = userTagProgress.find(t => t.slug === tag.slug) || { finishedNum: 0, totalNum: 0 };
            return progress.totalNum > 0 ? progress.finishedNum / progress.totalNum : 0;
        });
        famScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    const acScore = problem.acRate || 0;
    const diffMap = { EASY: 1, MEDIUM: 0.7, HARD: 0.4 };
    const diffScore = diffMap[problem.difficulty] || 0.5;

    return alpha * famScore + beta * diffScore + gamma * acScore;
}

// -------------------- Update Problem Row --------------------
function updateRowProbability(row, probability) {
    if (!row) return;
    row.setAttribute('data-prob', probability.toFixed(4));

    let acDiv = row.querySelector('div.flex.items-center.justify-center.text-sm');
    if (!acDiv) return;

    let probSpan = row.querySelector('.custom-probability');
    if (!probSpan) {
        probSpan = document.createElement('span');
        probSpan.className = 'custom-probability mr-2 font-semibold text-yellow-600';
        acDiv.parentNode.insertBefore(probSpan, acDiv);
    }

    probSpan.textContent = `${(probability * 100).toFixed(1)}%`;
}

// -------------------- Fetch AI Tag Boost --------------------
async function fetchAIProbabilityBoost(problem, userTagProgress) {
    try {
        const aiCombos = await new Promise(resolve => {
            const prompt = `Problem: "${problem.title}"
Tags: [${problem.topicTags.map(t => t.name).join(', ')}]
Suggest all useful tag combinations a user can solve this problem with.
Return ONLY as a JSON array of arrays. Example:
[["arrays"], ["arrays","hashtable"]]`;

            chrome.runtime.sendMessage({ type: 'ai_prompt', prompt }, (response) => {
                if (!response?.success) return resolve([]);
                try {
                    let rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
                    const combos = JSON.parse(rawText.replace(/json\s*|/gi, '').trim());
                    resolve(Array.isArray(combos) ? combos : []);
                } catch {
                    resolve([]);
                }
            });
        });

        if (!aiCombos.length) return 0;

        const comboScores = aiCombos.map(combo => {
            const score = combo.reduce((sum, tag) => {
                const progress = userTagProgress.find(t => t.name === tag) || { finishedNum: 0, totalNum: 0 };
                return sum + (progress.totalNum > 0 ? progress.finishedNum / progress.totalNum : 0);
            }, 0) / combo.length;
            return score;
        });

        return Math.max(...comboScores);
    } catch {
        return 0;
    }
}

// -------------------- Update all visible rows --------------------
async function updateVisibleRows(allProblems, userTagProgress) {
    const rows = document.querySelectorAll('a[href^="/problems/"]');
    for (const row of rows) {
        if (row.getAttribute('data-prob')) continue; // skip already processed

        const slug = row.getAttribute('href').split('/problems/')[1];
        const problem = allProblems.find(p => p.titleSlug === slug);
        if (!problem) continue;

        const baseProb = computeBaseProbability(problem, userTagProgress);
        updateRowProbability(row, baseProb);

        fetchAIProbabilityBoost(problem, userTagProgress).then(boost => {
            const finalProb = Math.min(baseProb + 0.2 * boost, 1);
            updateRowProbability(row, finalProb);
        });
    }
}

// -------------------- Optional Sorting --------------------
function addSortToggle() {
    if (document.querySelector('#sort-prob-toggle')) return;

    const container = document.querySelector('div[role="banner"]') || document.body;
    const wrapper = document.createElement('div');
    wrapper.style.margin = '10px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'sort-prob-toggle';
    checkbox.style.marginRight = '5px';

    const label = document.createElement('label');
    label.htmlFor = 'sort-prob-toggle';
    label.textContent = 'Sort by Probability';

    wrapper.appendChild(checkbox);
    wrapper.appendChild(label);
    container.prepend(wrapper);
}

function sortRowsByProbability() {
    const checkbox = document.querySelector('#sort-prob-toggle');
    if (!checkbox?.checked) return;

    const container = document.querySelector('div[role="rowgroup"]') || document.body;
    if (!container) return;

    const rows = Array.from(container.querySelectorAll('a[href^="/problems/"]'));

    rows.sort((a, b) => {
        const probA = parseFloat(a.getAttribute('data-prob')) || 0;
        const probB = parseFloat(b.getAttribute('data-prob')) || 0;
        return probB - probA; // descending
    });

    rows.forEach(row => container.appendChild(row));
}

// -------------------- Update & Sort Wrapper --------------------
async function updateAndSortVisibleRows(allProblems, userTagProgress) {
    await updateVisibleRows(allProblems, userTagProgress);
    sortRowsByProbability();
}

// -------------------- Observe Infinite Scroll --------------------
function observeNewRows(allProblems, userTagProgress) {
    const container = document.querySelector('div[role="rowgroup"]') || document.body;
    if (!container) return;

    const observer = new MutationObserver(() => {
        updateAndSortVisibleRows(allProblems, userTagProgress);
    });

    observer.observe(container, { childList: true, subtree: true });
}

// -------------------- Main --------------------
(async function main() {
    addSortToggle();

    const userTagProgress = await fetchUserTopicProgress();
    console.log('📝 Fetched user topic progress:', userTagProgress);

    let allProblems = [];
    let skip = 0;
    let batch;

    do {
        batch = await fetchProblems(skip);
        allProblems.push(...batch.questions);
        console.log(`✅ Fetched ${batch.questions.length} problems, total: ${allProblems.length}`);
        await updateAndSortVisibleRows(allProblems, userTagProgress);
        skip += BATCH_SIZE;
    } while (batch.hasMore);

    console.log('🎯 All problems fetched. Initial probabilities applied.');

    observeNewRows(allProblems, userTagProgress);

    setInterval(() => updateAndSortVisibleRows(allProblems, userTagProgress), 2000);
})();
