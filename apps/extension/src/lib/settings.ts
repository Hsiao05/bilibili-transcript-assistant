export type CleanStrength = "light" | "standard" | "compact";
export type ThemeMode = "light" | "dark" | "system";
export type AsrChoice = "auto" | "faster-whisper" | "dashscope-filetrans" | "openai-compatible";

export interface ExtensionSettings {
  serviceUrl: string;
  serviceToken: string;
  language: string;
  strength: CleanStrength;
  autoAsrFallback: boolean;
  showTimestamps: boolean;
  theme: ThemeMode;
  asrProvider: AsrChoice;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serviceUrl: "http://127.0.0.1:8765",
  serviceToken: "",
  language: "zh-CN",
  strength: "standard",
  autoAsrFallback: false,
  showTimestamps: true,
  theme: "system",
  asrProvider: "auto",
};

const STORAGE_KEY = "bili-transcript-settings";

const hasChromeStorage = () =>
  typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    if (hasChromeStorage()) {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] as Partial<ExtensionSettings> | undefined) };
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ExtensionSettings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function applyTheme(theme: ThemeMode): void {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export async function ensureServicePermission(serviceUrl: string): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.permissions?.request) return true;
  try {
    const url = new URL(serviceUrl);
    // Chrome match patterns do not support ports.
    const origin = `${url.protocol}//${url.hostname}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
