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

chrome.runtime.onMessage.addListener((message: { type?: string; seconds?: number }, _sender, sendResponse) => {
  if (message?.type === "content:getIdentity") {
    sendResponse({ ok: true, data: parseBiliIdentity(location.href, document.title) });
    return true;
  }
  if (message?.type === "player:seek") {
    const seconds = Number(message.seconds);
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
    const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video) {
      sendResponse({ ok: false, error: "video_not_found" });
      return true;
    }
    if (!Number.isFinite(seconds) || seconds < 0) {
      sendResponse({ ok: false, error: "invalid_time" });
      return true;
    }
    try {
      video.currentTime = seconds;
      // Keep the current play/pause intent: jumping should not force playback, but if the user
      // was already playing the browser continues automatically.
      sendResponse({ ok: true, currentTime: video.currentTime });
    } catch {
      sendResponse({ ok: false, error: "seek_failed" });
    }
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
