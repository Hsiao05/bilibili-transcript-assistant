import { getAudioTrack, getPlayerData, getSubtitleSegments, getViewData, normalizeTracks } from "../bilibili/api";
import { parseBiliIdentity } from "../bilibili/identity";
import type { BiliIdentity } from "../lib/messages";

const DNR_RULE_IDS = [9101, 9102, 9103];

async function installNetworkRules(): Promise<void> {
  if (!chrome.declarativeNetRequest) return;
  const referer = "https://www.bilibili.com/";
  const makeRule = (id: number, filter: string): chrome.declarativeNetRequest.Rule => ({
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        {
          header: "Referer",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: referer,
        },
      ],
    },
    condition: {
      urlFilter: filter,
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        chrome.declarativeNetRequest.ResourceType.MEDIA,
        chrome.declarativeNetRequest.ResourceType.OTHER,
      ],
      requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
      // B站页面自己发起的 CDN 请求必须保持原样，避免影响正常播放；扩展页面（侧栏）与
      // service worker 发起的请求没有 bilibili.com initiator，仍然会补上 Referer。
      excludedInitiatorDomains: ["bilibili.com"],
    },
  });
  const rules = [
    makeRule(9101, "||bilivideo.com"),
    makeRule(9102, "||bilivideo.cn"),
    makeRule(9103, "||hdslb.com"),
  ];
  try {
    // Session rules are re-installed on every worker start; dynamic rules are cleared so the
    // set cannot drift between browser sessions.
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: DNR_RULE_IDS, addRules: rules });
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS, addRules: [] });
  } catch (error) {
    console.warn("[background] session DNR rules unavailable, installing dynamic fallback", error);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS, addRules: rules });
    } catch (retryError) {
      console.warn("[background] DNR rules unavailable", retryError);
    }
  }
}

async function currentIdentity(): Promise<BiliIdentity> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) {
    return { bvid: null, page: 1, url: "", supported: false, reason: "当前没有活动标签页" };
  }
  const identity = parseBiliIdentity(tab.url, tab.title);
  return { ...identity, tabId: tab.id };
}

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: String((error as Error & { code?: string | number }).code ?? "error"), message: error.message };
  }
  return { code: "error", message: String(error) };
}

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  "identity:current": async () => currentIdentity(),

  "bili:view": async (payload) => {
    const bvid = String(payload.bvid || "");
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error("无效的 BV 号");
    return getViewData(bvid);
  },

  "bili:player": async (payload) => {
    const bvid = String(payload.bvid || "");
    const cid = String(payload.cid || "");
    if (!bvid || !cid) throw new Error("缺少视频标识");
    const data = await getPlayerData(bvid, cid);
    return {
      tracks: normalizeTracks(data.subtitle?.subtitles),
      allowSubmit: Boolean(data.subtitle?.allow_submit),
      rawTrackCount: data.subtitle?.subtitles?.length ?? 0,
    };
  },

  "bili:subtitle": async (payload) => {
    const url = String(payload.url || "");
    const body = await getSubtitleSegments(url);
    const segments = body.map((item, index) => ({
      id: `seg_${String(index + 1).padStart(5, "0")}`,
      startMs: Math.round(item.from * 1000),
      endMs: Math.round(item.to * 1000),
      text: item.content,
    }));
    return { segments };
  },

  "bili:playurl": async (payload) => {
    const bvid = String(payload.bvid || "");
    const cid = String(payload.cid || "");
    if (!bvid || !cid) throw new Error("缺少视频标识");
    return getAudioTrack(bvid, cid);
  },
};

async function broadcastPageChanged(identity: BiliIdentity): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "page:changed", identity });
  } catch {
    // No side panel open: ignore.
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string } & Record<string, unknown>, _sender, sendResponse) => {
  if (!message?.type) return false;
  if (message.type === "content:pageChanged") {
    void broadcastPageChanged(message.identity as BiliIdentity);
    return false;
  }
  const handler = handlers[message.type];
  if (!handler) return false;
  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void installNetworkRules();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void installNetworkRules();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url) {
    const identity = parseBiliIdentity(tab.url, tab.title);
    if (identity.supported) void broadcastPageChanged({ ...identity, tabId });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      const identity = parseBiliIdentity(tab.url, tab.title);
      if (identity.supported) void broadcastPageChanged({ ...identity, tabId });
    }
  } catch {
    // Ignore tabs that disappear.
  }
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void installNetworkRules();
