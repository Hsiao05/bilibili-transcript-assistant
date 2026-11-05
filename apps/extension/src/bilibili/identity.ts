import type { BiliIdentity } from "@/lib/messages";

const BV_RE = /\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/i;
const AV_RE = /\/video\/av(\d+)/i;
const BILI_HOSTS = ["bilibili.com", "bilibili.tv"];

function isBilibiliHost(host: string): boolean {
  const value = host.toLowerCase();
  return BILI_HOSTS.some((domain) => value === domain || value.endsWith(`.${domain}`));
}

export function parseBiliIdentity(url: string, title?: string): BiliIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { bvid: null, page: 1, url, title, supported: false, reason: "无法解析当前页面地址" };
  }
  if (!isBilibiliHost(parsed.hostname)) {
    return { bvid: null, page: 1, url, title, supported: false, reason: "当前不是 B 站页面" };
  }
  const bv = parsed.pathname.match(BV_RE);
  if (bv) {
    const pageValue = Number.parseInt(parsed.searchParams.get("p") || "1", 10);
    const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;
    const bvid = `BV${bv[1].slice(2)}`;
    return { bvid, page, url, title, supported: true };
  }
  if (AV_RE.test(parsed.pathname)) {
    return {
      bvid: null,
      page: 1,
      url,
      title,
      supported: false,
      reason: "首版仅支持 BV 视频地址，请打开标准视频页",
    };
  }
  return {
    bvid: null,
    page: 1,
    url,
    title,
    supported: false,
    reason: "当前页面不是普通视频页",
  };
}
