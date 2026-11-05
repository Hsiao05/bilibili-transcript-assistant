import SparkMD5 from "spark-md5";

/** WBI signing as used by bilibili.com (re-verified against the live interface during acceptance). */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

let cachedKeys: { imgKey: string; subKey: string; expiresAt: number } | null = null;

function keyFromUrl(url: string): string {
  const file = url.split("/").pop() ?? "";
  return file.split(".")[0];
}

export async function getWbiKeys(force = false): Promise<{ imgKey: string; subKey: string }> {
  if (!force && cachedKeys && cachedKeys.expiresAt > Date.now()) {
    return { imgKey: cachedKeys.imgKey, subKey: cachedKeys.subKey };
  }
  const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`WBI 密钥请求失败（HTTP ${response.status}）`);
  const payload = (await response.json()) as {
    code: number;
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };
  const imgUrl = payload.data?.wbi_img?.img_url;
  const subUrl = payload.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) throw new Error("无法取得 WBI 签名密钥，请确认已登录 B 站");
  const keys = { imgKey: keyFromUrl(imgUrl), subKey: keyFromUrl(subUrl) };
  cachedKeys = { ...keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return keys;
}

function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? "").join("").slice(0, 32);
}

export async function signWbi(
  params: Record<string, string | number>,
): Promise<Record<string, string>> {
  const { imgKey, subKey } = await getWbiKeys();
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    cleaned[key] = String(value).replace(/[!'()*]/g, "");
  }
  const wts = Math.round(Date.now() / 1000).toString();
  cleaned.wts = wts;
  const query = Object.keys(cleaned)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(cleaned[key])}`)
    .join("&");
  cleaned.w_rid = SparkMD5.hash(query + mixinKey(imgKey, subKey));
  return cleaned;
}

export function toQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
