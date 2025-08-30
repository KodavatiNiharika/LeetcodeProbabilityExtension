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
