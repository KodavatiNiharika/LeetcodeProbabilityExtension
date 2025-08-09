// background.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_LEETCODE_STATS') {
    // Placeholder: Fetch all submissions, fetch problem details, aggregate stats, and store in chrome.storage.local
    // Implement logic here
    sendResponse({ status: 'started' });
  }
}); 