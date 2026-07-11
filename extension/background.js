// BACKGROUND SERVICE WORKER (Manifest V3)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start_scan") {
    const tabId = message.tabId;
    
    // Inject content.js on demand
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    })
    .then(() => {
      // Send a message to content.js to trigger scanning
      chrome.tabs.sendMessage(tabId, { action: "scan_catalog", domain: message.domain }, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(res || { success: true });
        }
      });
    })
    .catch(err => {
      sendResponse({ error: "Falha ao injetar script de varredura: " + err.message });
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "scan_complete") {
    // Save scanned products into storage and open review dashboard
    chrome.storage.local.set({ 
      scannedProducts: message.products,
      scannedDomain: message.domain,
      scannedAt: new Date().toISOString()
    }, () => {
      chrome.tabs.create({ 
        url: chrome.runtime.getURL("review.html") 
      });
    });
    sendResponse({ success: true });
  }
});
