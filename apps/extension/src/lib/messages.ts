export interface BiliIdentity {
  bvid: string | null;
  page: number;
  url: string;
  tabId?: number;
  title?: string;
  supported: boolean;
  reason?: string;
}

export type BackgroundRequest =
  | { type: "identity:current" }
  | { type: "bili:view"; bvid: string }
  | { type: "bili:player"; bvid: string; cid: string }
  | { type: "bili:subtitle"; url: string }
  | { type: "bili:playurl"; bvid: string; cid: string }
  | { type: "page:changed"; identity: BiliIdentity };

export interface BackgroundError {
  code: string;
  message: string;
}

export type BackgroundResponse<T> = { ok: true; data: T } | { ok: false; error: BackgroundError };

export const extensionAvailable = (): boolean =>
  typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

export async function sendBackground<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!extensionAvailable()) throw new Error("扩展环境不可用");
  const response = (await chrome.runtime.sendMessage({ type, ...payload })) as BackgroundResponse<T> | undefined;
  if (!response) throw new Error("扩展后台未响应");
  if (!response.ok) {
    const error = new Error(response.error.message);
    (error as Error & { code?: string }).code = response.error.code;
    throw error;
  }
  return response.data;
}
