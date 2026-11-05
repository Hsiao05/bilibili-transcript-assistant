import { parseBiliIdentity } from "../bilibili/identity";

let lastUrl = location.href;

function report(): void {
  const identity = parseBiliIdentity(location.href, document.title);
  try {
    chrome.runtime.sendMessage({ type: "content:pageChanged", identity }).catch(() => undefined);
  } catch {
    // Extension context can be invalidated during reloads; ignore.
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === "content:getIdentity") {
    sendResponse({ ok: true, data: parseBiliIdentity(location.href, document.title) });
    return true;
  }
  return false;
});

window.addEventListener("popstate", () => {
  lastUrl = location.href;
  report();
});

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    window.setTimeout(report, 300);
  }
}, 900);

report();
