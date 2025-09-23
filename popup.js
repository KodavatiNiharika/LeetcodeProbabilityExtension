const LEETCODE_GRAPHQL = 'https://leetcode.com/graphql/';

async function fetchLeetCodeGraphQL(query, variables) {
    const res = await fetch(LEETCODE_GRAPHQL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*'
        },
        body: JSON.stringify({ query, variables })
    });
    return res.json();
}

// --- Fetch all submissions ---
async function fetchAllSubmissions() {
    const query = `
      query recentAcSubmissions($limit: Int!) {
        recentAcSubmissions(limit: $limit) {
          title
          titleSlug
          statusDisplay
          timestamp
        }
      }`;
    const data = await fetchLeetCodeGraphQL(query, { limit: 1000 });
    return data.data.recentAcSubmissions;
}

// --- Fetch problems by tag ---
async function fetchProblemsByTag(tagSlug) {
    const query = `
      query getProblems($tagSlug: String!) {
        problemsetQuestionList(filters: {tags: [$tagSlug]}) {
          questions {
            title
            titleSlug
            difficulty
            topicTags { name }
          }
        }
      }`;
    const data = await fetchLeetCodeGraphQL(query, { tagSlug });
    return data.data.problemsetQuestionList.questions;
}

// --- Calculate probability / stats ---
function calculateStats(submissions, problems) {
    const tagStats = {};
    const diffStats = { Easy: { attempted: 0, solved: 0 }, Medium: { attempted: 0, solved: 0 }, Hard: { attempted: 0, solved: 0 } };

    submissions.forEach(sub => {
        const prob = problems.find(p => p.titleSlug === sub.titleSlug);
        if (!prob) return;

        // Tag stats
        prob.topicTags.forEach(t => {
            if (!tagStats[t.name]) tagStats[t.name] = { attempted: 0, solved: 0 };
            tagStats[t.name].attempted++;
            if (sub.statusDisplay === 'Accepted') tagStats[t.name].solved++;
        });

        // Difficulty stats
        const diff = prob.difficulty;
        diffStats[diff].attempted++;
        if (sub.statusDisplay === 'Accepted') diffStats[diff].solved++;
    });

    // Example: overall probability
    let totalAttempted = 0, totalSolved = 0;
    Object.values(tagStats).forEach(t => {
        totalAttempted += t.attempted;
        totalSolved += t.solved;
    });
    const probability = totalAttempted ? ((totalSolved / totalAttempted) * 100).toFixed(2) + '%' : '0%';

    return { probability, tagStats, diffStats };
}

// --- Show detailed floating panel ---
function showDetailedStatsPanel(probability, tagStats, diffStats, problems, currentProb) {
    let existing = document.getElementById('leetcode-detailed-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'leetcode-detailed-panel';
    panel.style.position = 'absolute';
    panel.style.backgroundColor = '#1e1e2f';
    panel.style.color = '#fff';
    panel.style.border = '1px solid #fac31d';
    panel.style.padding = '12px';
    panel.style.borderRadius = '8px';
    panel.style.top = '60px';
    panel.style.right = '20px';
    panel.style.zIndex = '1000';
    panel.style.fontSize = '14px';
    panel.style.maxWidth = '300px';
    panel.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';

    const title = document.createElement('div');
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '6px';
    title.textContent = `Detailed Stats: ${currentProb.title}`;
    panel.appendChild(title);

    const probDiv = document.createElement('div');
    probDiv.style.marginBottom = '8px';
    probDiv.innerHTML = `<b>Overall Probability:</b> ${probability}`;
    panel.appendChild(probDiv);

    const tagHeader = document.createElement('div');
    tagHeader.style.fontWeight = 'bold';
    tagHeader.style.marginBottom = '4px';
    tagHeader.textContent = 'Tag Stats:';
    panel.appendChild(tagHeader);

    currentProb.topicTags.forEach(t => {
        const stats = tagStats[t.name] || { attempted: 0, solved: 0 };
        const fam = stats.attempted ? (stats.solved / stats.attempted * 100).toFixed(1) : '0.0';
        const tagLine = document.createElement('div');
        tagLine.textContent = `${t.name}: Fam ${fam}% | Solved ${stats.solved}/${stats.attempted}`;
        panel.appendChild(tagLine);
    });

    const diffHeader = document.createElement('div');
    diffHeader.style.fontWeight = 'bold';
    diffHeader.style.marginTop = '8px';
    diffHeader.textContent = 'Difficulty Stats:';
    panel.appendChild(diffHeader);

    ['Easy', 'Medium', 'Hard'].forEach(d => {
        const dStats = diffStats[d] || { attempted: 0, solved: 0 };
        const dLine = document.createElement('div');
        dLine.textContent = `${d}: Solved ${dStats.solved}/${dStats.attempted}`;
        panel.appendChild(dLine);
    });

    document.body.appendChild(panel);
}

// --- Event listeners ---
document.getElementById('btnFetchAllSubmissions').addEventListener('click', async () => {
    const output = document.getElementById('output');
    output.textContent = 'Fetching submissions...';
    const subs = await fetchAllSubmissions();
    window.submissionsCache = subs; // cache globally
    output.textContent = `Fetched ${subs.length} submissions.`;
});

document.getElementById('btnFetchTagProblems').addEventListener('click', async () => {
    const tag = document.getElementById('tagSlugInput').value.trim();
    const output = document.getElementById('tagStatsOutput');
    output.textContent = 'Fetching problems...';
    const problems = await fetchProblemsByTag(tag);
    window.problemsCache = problems;
    output.textContent = `Fetched ${problems.length} problems for tag "${tag}".`;
});

document.getElementById('btnCalculate').addEventListener('click', () => {
    const output = document.getElementById('output');
    if (!window.submissionsCache || !window.problemsCache) {
        output.textContent = 'Please fetch submissions and problems first.';
        return;
    }
    const { probability, tagStats, diffStats } = calculateStats(window.submissionsCache, window.problemsCache);
    output.textContent = `Overall Probability: ${probability}\n\nTag Stats: ${JSON.stringify(tagStats, null, 2)}\n\nDifficulty Stats: ${JSON.stringify(diffStats, null, 2)}`;

    // Optional: show floating panel for first problem
    if (window.problemsCache.length > 0) {
        showDetailedStatsPanel(probability, tagStats, diffStats, window.problemsCache, window.problemsCache[0]);
    }
});
