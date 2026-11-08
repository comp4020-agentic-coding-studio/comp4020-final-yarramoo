// localStorage keys shared between the room page and the menu (R3): the name sheet reuses the exact storage
// the sandbox/game pages already had (client/main.ts:50 before this slice), not a new mechanism.
export const TOKEN_KEY = "sand.token";
export const NAME_KEY = "sand.name";
/** First-visit-per-mode hint (R3 commit 5), keyed per mode alongside the name. */
export const HINT_SEEN_PREFIX = "sand.hint.";

export const store = {
  get: (k: string): string => {
    try {
      return localStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode: the player lasts for this tab only
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // nothing stored
    }
  },
};
