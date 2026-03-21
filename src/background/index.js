import {
  AUTO_COPY_MAX_WAIT_MS,
  AUTO_COPY_PENDING_KEY,
  MESSAGE_TYPE_AUTHORIZE,
  MESSAGE_TYPE_CLEAR,
  MESSAGE_TYPE_COPY,
  REQUIRED_SELECTOR_PREFIXES,
} from "../shared/constants.js";

const TAB_LOAD_TIMEOUT_MS = 15000;
const AUTH_POLL_ATTEMPTS = 20;
const AUTH_POLL_INTERVAL_MS = 500;
const AUTO_COPY_STORAGE = chrome.storage.session ?? chrome.storage.local;

chrome.cookies.onChanged.addListener((changeInfo) => {
  void handleCookieChange(changeInfo);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    void handleTabComplete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return undefined;
  }

  switch (message.type) {
    case MESSAGE_TYPE_COPY:
      copyCookies(message.payload)
        .then((result) => sendResponse({ success: true, result }))
        .catch((error) => {
          console.error("Не удалось скопировать cookie:", error);
          sendResponse({ success: false, error: error.message ?? String(error) });
        });
      return true;

    case MESSAGE_TYPE_CLEAR:
      clearCookies(message.payload)
        .then((result) => sendResponse({ success: true, result }))
        .catch((error) => {
          console.error("Ошибка очистки cookie:", error);
          sendResponse({ success: false, error: error.message ?? String(error) });
        });
      return true;

    case MESSAGE_TYPE_AUTHORIZE:
      authorize(message.payload)
        .then((result) => sendResponse({ success: true, result }))
        .catch((error) => {
          console.error("Ошибка автоматической авторизации:", error);
          sendResponse({ success: false, error: error.message ?? String(error) });
        });
      return true;

    default:
      return undefined;
  }
});

async function copyCookies({ sourceUrl, destinationUrl, copyAll, keys }) {
  validateUrl(sourceUrl, "URL источника");
  validateUrl(destinationUrl, "URL назначения");

  const trimmedKeys = (keys ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const keySet = copyAll ? null : new Set(trimmedKeys);
  const source = new URL(sourceUrl);
  const destination = new URL(destinationUrl);
  const cookies = await getCookiesForCopy(source);
  const filteredCookies = cookies.filter((cookie) =>
    keySet ? keySet.has(cookie.name) : true
  );

  const summary = {
    attempted: filteredCookies.length,
    copied: 0,
    skipped: cookies.length - filteredCookies.length,
    errors: [],
  };

  for (const cookie of filteredCookies) {
    try {
      await setCookie(buildSetDetails(cookie, destination));
      summary.copied += 1;
    } catch (error) {
      const message = error.message ?? String(error);
      summary.errors.push({ name: cookie.name, message });
      console.warn(`Cookie "${cookie.name}" не удалось установить: ${message}`);
    }
  }

  return summary;
}

async function clearCookies({ url }) {
  validateUrl(url, "URL для очистки cookie");

  const targetUrl = new URL(url);
  const cookies = await getCookies({ url: targetUrl.origin });
  const summary = {
    removed: 0,
    total: cookies.length,
    host: targetUrl.hostname,
    errors: [],
  };

  for (const cookie of cookies) {
    try {
      await removeCookie(buildRemoveDetails(cookie));
      summary.removed += 1;
    } catch (error) {
      const message = error.message ?? String(error);
      summary.errors.push({ name: cookie.name, message });
      console.warn(`Cookie "${cookie.name}" не удалось удалить: ${message}`);
    }
  }

  return summary;
}

async function authorize({ serviceId, url, username, password, selectors, autoCopy }) {
  validateUrl(url, "URL ресурса авторизации");

  if (!username) {
    throw new Error("Укажите логин для авторизации.");
  }

  if (!password) {
    throw new Error("Укажите пароль для авторизации.");
  }

  const tab = await createTab({ url });
  if (tab.id === undefined) {
    throw new Error("Не удалось открыть вкладку для авторизации.");
  }

  await waitForTabReady(tab.id);

  const injectionResults = await executeAuthorizationScript(tab.id, {
    username,
    password,
    selectors: normalizeSelectors(selectors),
    attempts: AUTH_POLL_ATTEMPTS,
    interval: AUTH_POLL_INTERVAL_MS,
  });

  const scriptResult = injectionResults?.[0]?.result;
  if (!scriptResult?.success) {
    throw new Error(scriptResult?.error ?? "Не удалось заполнить форму авторизации.");
  }

  const pendingAutoCopy = normalizePendingAutoCopyJob({
    serviceId,
    tabId: tab.id,
    authUrl: url,
    autoCopy,
  });

  if (pendingAutoCopy) {
    await upsertPendingAutoCopyJob(pendingAutoCopy);
    await attemptAutoCopy(pendingAutoCopy);
  } else if (serviceId) {
    await removePendingAutoCopyJob(serviceId);
  }

  const baseMessage = scriptResult.message ?? `Авторизация выполнена на ${url}.`;

  return {
    message: pendingAutoCopy
      ? `${baseMessage} Автокопирование cookie отслеживается в фоне.`
      : baseMessage,
    errors: scriptResult.errors ?? [],
  };
}

function validateUrl(urlString, label) {
  if (!urlString) {
    throw new Error(`${label} не указан.`);
  }

  try {
    const url = new URL(urlString);
    if (!url.protocol.startsWith("http")) {
      throw new Error("Поддерживаются только протоколы http и https.");
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Некорректный формат URL";
    throw new Error(`${label} некорректен: ${reason}`);
  }
}

function buildSetDetails(cookie, destinationUrl) {
  const cookiePath = cookie.path || "/";
  const details = {
    url: `${destinationUrl.origin}${cookiePath}`,
    name: cookie.name,
    value: cookie.value,
    path: cookiePath,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };

  if (cookie.secure && destinationUrl.protocol !== "https:") {
    throw new Error(
      `Cookie "${cookie.name}" требует HTTPS, но URL назначения использует ${destinationUrl.protocol}`
    );
  }

  if (!cookie.hostOnly) {
    details.domain = destinationUrl.hostname;
  }

  if (!cookie.session && cookie.expirationDate) {
    details.expirationDate = cookie.expirationDate;
  }

  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }

  if (cookie.priority) {
    details.priority = cookie.priority;
  }

  if (cookie.sameParty) {
    details.sameParty = cookie.sameParty;
  }

  return details;
}

function buildRemoveDetails(cookie) {
  const domain = cookie.domain?.startsWith(".")
    ? cookie.domain.slice(1)
    : cookie.domain ?? "";
  const details = {
    url: `${cookie.secure ? "https" : "http"}://${domain}${cookie.path || "/"}`,
    name: cookie.name,
  };

  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }

  return details;
}

function normalizeSelectors(rawSelectors = {}) {
  const normalized = {
    username: String(rawSelectors.username ?? "").trim(),
    password: String(rawSelectors.password ?? "").trim(),
    submit: String(rawSelectors.submit ?? "").trim(),
  };

  for (const [key, selector] of Object.entries(normalized)) {
    if (!selector) {
      throw new Error(`Селектор ${key} не может быть пустым.`);
    }

    if (!REQUIRED_SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix))) {
      throw new Error(
        `Селектор ${key} должен начинаться с "${REQUIRED_SELECTOR_PREFIXES.join(
          '" или "'
        )}".`
      );
    }
  }

  return normalized;
}

function normalizePendingAutoCopyJob({ serviceId, tabId, authUrl, autoCopy }) {
  if (!autoCopy?.enabled) {
    return null;
  }

  validateUrl(autoCopy.sourceUrl, "URL источника автокопирования");
  validateUrl(autoCopy.destinationUrl, "URL назначения автокопирования");

  const resolvedPair = resolveAutoCopyPair({
    authUrl,
    sourceUrl: autoCopy.sourceUrl,
    destinationUrl: autoCopy.destinationUrl,
  });

  return {
    id:
      typeof serviceId === "string" && serviceId.trim()
        ? serviceId
        : createPendingAutoCopyId(),
    tabId,
    authUrl,
    sourceUrl: resolvedPair.sourceUrl,
    destinationUrl: resolvedPair.destinationUrl,
    copyAll: Boolean(autoCopy.copyAll),
    keys: String(autoCopy.keys ?? "").trim(),
    expiresAt: Date.now() + AUTO_COPY_MAX_WAIT_MS,
  };
}

function resolveAutoCopyPair({ authUrl, sourceUrl, destinationUrl }) {
  if (urlsShareHost(authUrl, destinationUrl) && !urlsShareHost(authUrl, sourceUrl)) {
    return {
      sourceUrl: destinationUrl,
      destinationUrl: sourceUrl,
    };
  }

  return { sourceUrl, destinationUrl };
}

function urlsShareHost(leftUrlString, rightUrlString) {
  try {
    const leftHostname = new URL(leftUrlString).hostname;
    const rightHostname = new URL(rightUrlString).hostname;
    return (
      leftHostname === rightHostname ||
      leftHostname.endsWith(`.${rightHostname}`) ||
      rightHostname.endsWith(`.${leftHostname}`)
    );
  } catch {
    return false;
  }
}

async function handleCookieChange(changeInfo) {
  if (!changeInfo?.cookie) {
    return;
  }

  await processPendingAutoCopyJobs({
    shouldRun: (job) => cookieMatchesUrl(changeInfo.cookie, job.sourceUrl),
    removeAfterRun: false,
  });
}

async function handleTabComplete(tabId) {
  await processPendingAutoCopyJobs({
    shouldRun: (job) => job.tabId === tabId,
    removeAfterRun: false,
  });
}

async function handleTabRemoved(tabId) {
  await processPendingAutoCopyJobs({
    shouldRun: (job) => job.tabId === tabId,
    removeAfterRun: true,
  });
}

async function processPendingAutoCopyJobs({ shouldRun, removeAfterRun }) {
  const jobs = await loadPendingAutoCopyJobs();
  if (!jobs.length) {
    return;
  }

  const now = Date.now();
  const nextJobs = [];
  let changed = false;

  for (const job of jobs) {
    if (isPendingAutoCopyExpired(job, now)) {
      changed = true;
      continue;
    }

    if (!shouldRun(job)) {
      nextJobs.push(job);
      continue;
    }

    try {
      await attemptAutoCopy(job);
    } catch (error) {
      console.error("Не удалось выполнить автокопирование cookie:", error);
    }

    if (removeAfterRun) {
      changed = true;
      continue;
    }

    nextJobs.push(job);
  }

  if (changed) {
    await savePendingAutoCopyJobs(nextJobs);
  }
}

async function attemptAutoCopy(job) {
  return copyCookies({
    sourceUrl: job.sourceUrl,
    destinationUrl: job.destinationUrl,
    copyAll: job.copyAll,
    keys: job.keys,
  });
}

function isPendingAutoCopyExpired(job, now = Date.now()) {
  return !job?.expiresAt || job.expiresAt <= now;
}

function createPendingAutoCopyId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `auto-copy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadPendingAutoCopyJobs() {
  const stored = await AUTO_COPY_STORAGE.get(AUTO_COPY_PENDING_KEY);
  return Array.isArray(stored?.[AUTO_COPY_PENDING_KEY]) ? stored[AUTO_COPY_PENDING_KEY] : [];
}

async function savePendingAutoCopyJobs(jobs) {
  await AUTO_COPY_STORAGE.set({ [AUTO_COPY_PENDING_KEY]: jobs });
}

async function upsertPendingAutoCopyJob(job) {
  const jobs = await loadPendingAutoCopyJobs();
  const now = Date.now();
  const nextJobs = jobs.filter(
    (item) => !isPendingAutoCopyExpired(item, now) && item.id !== job.id && item.tabId !== job.tabId
  );
  nextJobs.push(job);
  await savePendingAutoCopyJobs(nextJobs);
}

async function removePendingAutoCopyJob(jobId) {
  const jobs = await loadPendingAutoCopyJobs();
  const nextJobs = jobs.filter((job) => job.id !== jobId);

  if (nextJobs.length !== jobs.length) {
    await savePendingAutoCopyJobs(nextJobs);
  }
}

function cookieMatchesUrl(cookie, urlString) {
  try {
    const url = new URL(urlString);
    const cookieDomain = normalizeCookieDomain(cookie.domain);

    if (!cookieDomain) {
      return false;
    }

    if (cookie.hostOnly) {
      return url.hostname === cookieDomain;
    }

    return url.hostname === cookieDomain || url.hostname.endsWith(`.${cookieDomain}`);
  } catch {
    return false;
  }
}

function normalizeCookieDomain(domain) {
  return String(domain ?? "")
    .trim()
    .replace(/^\./, "");
}

async function getCookiesForCopy(url) {
  const cookies = await getCookies({});
  return cookies.filter((cookie) => cookieMatchesUrl(cookie, url.href));
}

function getCookies(filter) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(filter, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(cookies ?? []);
    });
  });
}

function setCookie(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.set(details, (cookie) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(cookie);
    });
  });
}

function removeCookie(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.remove(details, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!result) {
        reject(new Error("Cookie не найдено для удаления."));
        return;
      }

      resolve(result);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

async function waitForTabReady(tabId) {
  const initialTab = await getTab(tabId);
  if (initialTab.status === "complete") {
    return initialTab;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Таймаут ожидания загрузки страницы для авторизации."));
    }, TAB_LOAD_TIMEOUT_MS);

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    const handleRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error("Вкладка авторизации была закрыта до завершения загрузки."));
      }
    };

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.tabs.onRemoved.addListener(handleRemoved);
  });

  return getTab(tabId);
}

function executeAuthorizationScript(tabId, args) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: fillAuthorizationForm,
    args: [args],
  });
}

async function fillAuthorizationForm({
  username,
  password,
  selectors,
  attempts,
  interval,
}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const applyFieldValue = (element, value) => {
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const usernameField = document.querySelector(selectors.username);
    const passwordField = document.querySelector(selectors.password);
    const submitButton = document.querySelector(selectors.submit);

    if (usernameField && passwordField && submitButton) {
      applyFieldValue(usernameField, username);
      applyFieldValue(passwordField, password);
      submitButton.click();

      return {
        success: true,
        message: "Данные авторизации заполнены и отправлены.",
      };
    }

    await wait(interval);
  }

  const missingParts = [];
  if (!document.querySelector(selectors.username)) {
    missingParts.push("поле логина");
  }
  if (!document.querySelector(selectors.password)) {
    missingParts.push("поле пароля");
  }
  if (!document.querySelector(selectors.submit)) {
    missingParts.push("кнопка входа");
  }

  return {
    success: false,
    error: `Не удалось найти: ${missingParts.join(", ") || "нужные элементы"}.`,
  };
}
