// Configuration injected by FastAPI at request time. The server replaces the
// `__ROBSKC_CONFIG__` sentinel in `static/index.html` with a JSON blob so the
// SPA never needs to make an extra round-trip just to learn whether the
// trigger surface is enabled.

export interface AppConfig {
  replayEnabled: boolean;
}

function readConfig(): AppConfig {
  const node = document.getElementById("roboskc-config");
  const text = node?.textContent?.trim();
  if (!text || text === "__ROBSKC_CONFIG__") {
    return { replayEnabled: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { replayEnabled: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      replayEnabled: Boolean(record.replayEnabled),
    };
  } catch {
    return { replayEnabled: false };
  }
}

export const CONFIG: AppConfig = readConfig();

const REPLAY_TOKEN_STORAGE_KEY = "roboskc:replay-token";

export function replayAuthHeaders(): Record<string, string> {
  if (!CONFIG.replayEnabled) return {};
  const cached = window.sessionStorage.getItem(REPLAY_TOKEN_STORAGE_KEY)?.trim();
  if (cached) return { "X-Roboskc-Replay-Token": cached };
  const token = window.prompt("ROBSKC replay token")?.trim();
  if (!token) return {};
  window.sessionStorage.setItem(REPLAY_TOKEN_STORAGE_KEY, token);
  return { "X-Roboskc-Replay-Token": token };
}

export const POLL_INTERVAL_MS = 3000;
