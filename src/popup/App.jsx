import { useEffect, useRef, useState } from "react";
import {
  AUTO_COPY_RETRY_COUNT,
  AUTO_COPY_RETRY_DELAY_MS,
  defaultSettings,
  MESSAGE_TYPE_AUTHORIZE,
  MESSAGE_TYPE_CLEAR,
  MESSAGE_TYPE_COPY,
  REQUIRED_SELECTOR_PREFIXES,
  SAVE_DEBOUNCE_MS,
  STORAGE_KEY,
} from "../shared/constants.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function App() {
  const [settings, setSettings] = useState(defaultSettings);
  const [status, setStatus] = useState({ message: "", isError: false, errors: [] });
  const [copyLoading, setCopyLoading] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [authorizeLoading, setAuthorizeLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const saveTimeoutRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    loadSettings()
      .then((storedSettings) => {
        if (!cancelled) {
          setSettings(storedSettings);
          setIsHydrated(true);
        }
      })
      .catch((error) => {
        console.error("Не удалось инициализировать окно расширения:", error);
        if (!cancelled) {
          setStatus({
            message: `Не удалось загрузить настройки: ${error.message}`,
            isError: true,
            errors: [],
          });
          setIsHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return undefined;
    }

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      persistSettings(settings).catch((error) => {
        console.error("Не удалось сохранить настройки:", error);
      });
      saveTimeoutRef.current = null;
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [settings, isHydrated]);

  const authValues = getAuthValues(settings);
  const authorizeDisabled = authorizeLoading || !areAuthFieldsValid(authValues);

  async function saveSettingsImmediately(nextSettings) {
    setSettings(nextSettings);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    await persistSettings(nextSettings);
  }

  function updateField(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function clearStatus() {
    setStatus({ message: "", isError: false, errors: [] });
  }

  function showStatus(message, isError = false, errors = []) {
    setStatus({ message, isError, errors });
  }

  async function copyCookies(options = {}) {
    const { mode = "manual", retries = 0, retryDelayMs = 500 } = options;
    const isManual = mode === "manual";

    if (isManual) {
      clearStatus();
      setCopyLoading(true);
    }

    const payload = {
      sourceUrl: settings.sourceUrl.trim(),
      destinationUrl: settings.destinationUrl.trim(),
      keys: settings.keys.trim(),
      copyAll: settings.copyAll,
    };

    try {
      await saveSettingsImmediately({ ...settings, ...payload });
    } catch (error) {
      if (isManual) {
        showStatus(`Не удалось сохранить настройки: ${error.message}`, true);
      }
      return { success: false, error };
    }

    let lastError = null;

    try {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (!isManual && attempt > 0) {
          await delay(retryDelayMs);
        }

        try {
          const response = await sendRuntimeMessage({
            type: MESSAGE_TYPE_COPY,
            payload,
          });

          if (!response?.success) {
            throw new Error(response?.error ?? "Не удалось выполнить копирование.");
          }

          const result = response.result ?? {
            copied: 0,
            attempted: 0,
            skipped: 0,
            errors: [],
          };

          if (!isManual && attempt < retries && (result.attempted ?? 0) === 0) {
            continue;
          }

          const summaryParts = [
            `Скопировано cookie: ${result.copied}`,
            `Попыток: ${result.attempted}`,
          ];

          if (result.skipped) {
            summaryParts.push(`Пропущено: ${result.skipped}`);
          }

          const summary = summaryParts.join(", ");

          if (isManual) {
            showStatus(summary, false, result.errors ?? []);
          }

          return {
            success: true,
            summary,
            errors: result.errors ?? [],
            details: result,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.error("Не удалось скопировать cookie:", lastError);

          if (isManual || attempt === retries) {
            if (isManual) {
              showStatus(lastError.message ?? String(lastError), true);
            }

            return { success: false, error: lastError };
          }
        }
      }
    } finally {
      if (isManual) {
        setCopyLoading(false);
      }
    }

    return {
      success: false,
      error: lastError ?? new Error("Не удалось скопировать cookie автоматически."),
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await copyCookies();
  }

  async function handleClearCookies() {
    clearStatus();
    setClearLoading(true);

    try {
      let [activeTab] = await queryTabs({
        active: true,
        lastFocusedWindow: true,
      });

      if (!activeTab) {
        [activeTab] = await queryTabs({ active: true, currentWindow: true });
      }

      const url = typeof activeTab?.url === "string" ? activeTab.url.trim() : "";
      if (!url) {
        showStatus("Не удалось определить URL текущей вкладки.", true);
        return;
      }

      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPE_CLEAR,
        payload: { url },
      });

      if (!response?.success) {
        throw new Error(response?.error ?? "Не удалось очистить cookie.");
      }

      const { removed, total, host, errors } = response.result ?? {};
      const hostLabel = host ? ` (${host})` : "";
      showStatus(
        `Удалено cookie: ${removed ?? 0} из ${total ?? 0}${hostLabel}.`,
        false,
        errors ?? []
      );
    } catch (error) {
      console.error("Ошибка очистки cookie:", error);
      showStatus(error.message ?? String(error), true);
    } finally {
      setClearLoading(false);
    }
  }

  async function handleAuthorize() {
    clearStatus();

    if (!areAuthFieldsValid(authValues)) {
      showStatus("Заполните все поля авторизации и селекторы.", true);
      return;
    }

    const selectorValidation = validateSelectors(authValues);
    if (!selectorValidation.valid) {
      showStatus(selectorValidation.message, true);
      return;
    }

    const nextSettings = {
      ...settings,
      authUrl: authValues.url,
      authUsername: authValues.username,
      authPassword: authValues.password,
      authUsernameSelector: authValues.usernameSelector,
      authPasswordSelector: authValues.passwordSelector,
      authSubmitSelector: authValues.submitSelector,
    };

    try {
      await saveSettingsImmediately(nextSettings);
    } catch (error) {
      showStatus(`Не удалось сохранить настройки авторизации: ${error.message}`, true);
      return;
    }

    setAuthorizeLoading(true);

    try {
      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPE_AUTHORIZE,
        payload: {
          url: authValues.url,
          username: authValues.username,
          password: authValues.password,
          selectors: {
            username: authValues.usernameSelector,
            password: authValues.passwordSelector,
            submit: authValues.submitSelector,
          },
        },
      });

      if (!response?.success) {
        throw new Error(response?.error ?? "Не удалось выполнить авторизацию.");
      }

      const authMessage =
        response.result?.message ?? "Авторизация и заполнение формы выполнены.";
      const authErrors = response.result?.errors ?? [];
      let statusText = authMessage;
      let combinedErrors = [...authErrors];

      if (shouldAutoCopyAfterAuth(settings)) {
        const autoCopyResult = await copyCookies({
          mode: "auto",
          retries: AUTO_COPY_RETRY_COUNT,
          retryDelayMs: AUTO_COPY_RETRY_DELAY_MS,
        });

        if (autoCopyResult.success) {
          statusText = `${authMessage} ${autoCopyResult.summary}`;
          if (autoCopyResult.errors?.length) {
            combinedErrors = [...authErrors, ...autoCopyResult.errors];
          }
        } else if (autoCopyResult.error) {
          statusText = `${authMessage} ${autoCopyResult.error.message ?? String(autoCopyResult.error)}`;
        }
      }

      showStatus(statusText, false, combinedErrors);
    } catch (error) {
      console.error("Ошибка автоматической авторизации:", error);
      showStatus(error.message ?? String(error), true);
    } finally {
      setAuthorizeLoading(false);
    }
  }

  return (
    <main>
      <h1>Cookie Copy Paster</h1>
      <form onSubmit={handleSubmit}>
        <details className="accordion">
          <summary>Настройки cookie</summary>
          <div className="accordion-content">
            <label className="field">
              <span>URL источника</span>
              <input
                type="url"
                value={settings.sourceUrl}
                onChange={(event) => updateField("sourceUrl", event.target.value)}
                placeholder="https://example.com"
                required
              />
            </label>

            <label className="field">
              <span>URL назначения</span>
              <input
                type="url"
                value={settings.destinationUrl}
                onChange={(event) => updateField("destinationUrl", event.target.value)}
                placeholder="https://target.com"
                required
              />
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.copyAll}
                onChange={(event) => updateField("copyAll", event.target.checked)}
              />
              <span>Скопировать все cookie</span>
            </label>

            <label className="field">
              <span>Ключи cookie (через запятую)</span>
              <textarea
                rows="3"
                value={settings.keys}
                onChange={(event) => updateField("keys", event.target.value)}
                placeholder={
                  settings.copyAll ? "Список не используется" : "session_id, auth_token"
                }
                disabled={settings.copyAll}
              />
            </label>
          </div>
        </details>

        <div className="actions">
          <button className="primary-button" type="submit" disabled={copyLoading}>
            {copyLoading ? "Копирование..." : "Скопировать"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={clearLoading}
            onClick={handleClearCookies}
          >
            {clearLoading ? "Очищаем..." : "Очистить куки"}
          </button>
        </div>

        <button
          className="primary-button auth-button"
          type="button"
          disabled={authorizeDisabled}
          onClick={handleAuthorize}
        >
          {authorizeLoading ? "Авторизация..." : "Авторизоваться"}
        </button>

        <details className="accordion">
          <summary>Авторизация</summary>
          <div className="accordion-content">
            <label className="field">
              <span>URL ресурса</span>
              <input
                type="url"
                value={settings.authUrl}
                onChange={(event) => updateField("authUrl", event.target.value)}
                placeholder="https://example.com/login"
                autoComplete="url"
              />
            </label>

            <label className="field">
              <span>Логин</span>
              <input
                type="text"
                value={settings.authUsername}
                onChange={(event) => updateField("authUsername", event.target.value)}
                placeholder="username"
                autoComplete="username"
              />
            </label>

            <label className="field">
              <span>Пароль</span>
              <input
                type="password"
                value={settings.authPassword}
                onChange={(event) => updateField("authPassword", event.target.value)}
                placeholder="password"
                autoComplete="current-password"
              />
            </label>

            <label className="field">
              <span>Селектор поля логина</span>
              <input
                type="text"
                value={settings.authUsernameSelector}
                onChange={(event) =>
                  updateField("authUsernameSelector", event.target.value)
                }
                placeholder="#login-input"
              />
            </label>

            <label className="field">
              <span>Селектор поля пароля</span>
              <input
                type="text"
                value={settings.authPasswordSelector}
                onChange={(event) =>
                  updateField("authPasswordSelector", event.target.value)
                }
                placeholder="#password-input"
              />
            </label>

            <label className="field">
              <span>Селектор кнопки входа</span>
              <input
                type="text"
                value={settings.authSubmitSelector}
                onChange={(event) => updateField("authSubmitSelector", event.target.value)}
                placeholder="#login-button"
              />
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autoCopyAfterAuth}
                onChange={(event) =>
                  updateField("autoCopyAfterAuth", event.target.checked)
                }
              />
              <span>Автоматически копировать cookie после авторизации</span>
            </label>
          </div>
        </details>
      </form>

      {status.message ? (
        <section className={`status-panel${status.isError ? " error" : ""}`}>
          <h2>Результат</h2>
          <p>{status.message}</p>
          {status.errors.length ? (
            <ul className="error-list">
              {status.errors.map(({ name, message }, index) => (
                <li key={`${name}-${message}-${index}`}>
                  {name}: {message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaultSettings, ...(stored?.[STORAGE_KEY] ?? {}) };
}

async function persistSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tabs);
    });
  });
}

function shouldAutoCopyAfterAuth(settings) {
  if (!settings.autoCopyAfterAuth) {
    return false;
  }

  return Boolean(settings.sourceUrl.trim() && settings.destinationUrl.trim());
}

function getAuthValues(settings) {
  return {
    url: settings.authUrl.trim(),
    username: settings.authUsername,
    password: settings.authPassword,
    usernameSelector: settings.authUsernameSelector.trim(),
    passwordSelector: settings.authPasswordSelector.trim(),
    submitSelector: settings.authSubmitSelector.trim(),
  };
}

function areAuthFieldsValid(values) {
  return Boolean(
    values.url &&
      values.username &&
      values.password &&
      values.usernameSelector &&
      values.passwordSelector &&
      values.submitSelector
  );
}

function validateSelectors({ usernameSelector, passwordSelector, submitSelector }) {
  const checks = [
    { selector: usernameSelector, label: "Селектор поля логина" },
    { selector: passwordSelector, label: "Селектор поля пароля" },
    { selector: submitSelector, label: "Селектор кнопки входа" },
  ];

  for (const { selector, label } of checks) {
    if (!REQUIRED_SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix))) {
      return {
        valid: false,
        message: `${label} должен начинаться с "${REQUIRED_SELECTOR_PREFIXES.join(
          '" или "'
        )}".`,
      };
    }
  }

  return { valid: true };
}
