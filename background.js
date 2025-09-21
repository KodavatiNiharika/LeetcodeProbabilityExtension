chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ai_prompt') {
    (async () => {
      try {
        const res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-goog-api-key': 'key' 
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: request.prompt }] }]
            })
          }
        );

        const data = await res.json();
        console.log("Full response from Gemini:", JSON.stringify(data, null, 2));

        // Send the full response to content script
        sendResponse({ success: true, data });

      } catch (err) {
        console.error("AI request failed:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    // Keep the message channel open for async response
    return true;
  }
});
