chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ---- AI Prompt Handler ----
  if (request.type === 'ai_prompt') {
    (async () => {
      try {
        if (!request.prompt) throw new Error("No prompt provided");
        const res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-goog-api-key': 'YOUR_API_KEY'
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: request.prompt }] }]
            })
          }
        );
        const data = await res.json();
        sendResponse({ success: true, data });
      } catch (err) {
        console.error("AI request failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep port open for async response
  }

  // ---- GraphQL Handler ----
  if (request.type === 'graphql') {
    (async () => {
      try {
        const res = await fetch('https://leetcode.com/graphql/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: request.query, variables: request.variables })
        });
        const data = await res.json();
        sendResponse({ success: true, data });
      } catch (err) {
        console.error("GraphQL fetch failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep port open
  }

});
