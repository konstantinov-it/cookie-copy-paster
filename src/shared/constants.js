export const STORAGE_KEY = "cookieCopyPaster.settings";
export const MESSAGE_TYPE_COPY = "copyCookies";
export const MESSAGE_TYPE_CLEAR = "clearCookies";
export const MESSAGE_TYPE_AUTHORIZE = "authorize";
export const SAVE_DEBOUNCE_MS = 300;
export const REQUIRED_SELECTOR_PREFIXES = ["#", "."];
export const AUTO_COPY_RETRY_COUNT = 3;
export const AUTO_COPY_RETRY_DELAY_MS = 700;

export const defaultSettings = {
  sourceUrl: "",
  destinationUrl: "https://localhost:5173/",
  keys: "",
  copyAll: true,
  autoCopyAfterAuth: true,
  authUrl: "",
  authUsername: "",
  authPassword: "",
  authUsernameSelector: "#USERNAME_FIELD-inner",
  authPasswordSelector: "#PASSWORD_FIELD-inner",
  authSubmitSelector: "#LOGIN_LINK",
};
