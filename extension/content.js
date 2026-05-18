// JuriScan — Content Script
// Extracts visible text from the current page

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractText") {
    const text = extractPageText();
    sendResponse({ text });
  }
  return true;
});

function extractPageText() {
  // Remove script/style tags first
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, noscript").forEach(el => el.remove());

  // Get visible text
  const text = clone.innerText || clone.textContent || "";

  // Clean up excessive whitespace
  return text.replace(/\s{3,}/g, "\n\n").trim().slice(0, 8000);
}
