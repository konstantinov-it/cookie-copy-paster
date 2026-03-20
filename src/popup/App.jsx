import { ChevronDown, Copy, LoaderCircle, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  AUTO_COPY_RETRY_COUNT,
  AUTO_COPY_RETRY_DELAY_MS,
  defaultServiceSettings,
  MESSAGE_TYPE_AUTHORIZE,
  MESSAGE_TYPE_CLEAR,
  MESSAGE_TYPE_COPY,
  REQUIRED_SELECTOR_PREFIXES,
  SAVE_DEBOUNCE_MS,
  STORAGE_KEY,
} from "../shared/constants.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function App() {
  const [services, setServices] = useState(() => [createServiceSettings()]);
  const [status, setStatus] = useState(createEmptyStatus);
  const [loadingStates, setLoadingStates] = useState({});
  const [clearLoading, setClearLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const saveTimeoutRef = useRef(null);
  const servicesRef = useRef(services);

  useEffect(() => {
    servicesRef.current = services;
  }, [services]);

  useEffect(() => {
    let cancelled = false;

    loadSettings()
      .then((storedSettings) => {
        if (!cancelled) {
          setServices(storedSettings.services);
          servicesRef.current = storedSettings.services;
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
      persistSettings(servicesRef.current).catch((error) => {
        console.error("Не удалось сохранить настройки:", error);
      });
      saveTimeoutRef.current = null;
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [services, isHydrated]);

  async function saveSettingsImmediately(nextServices) {
    setServices(nextServices);
    servicesRef.current = nextServices;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    await persistSettings(nextServices);
  }

  function updateField(serviceId, key, value) {
    setServices((current) => {
      const nextServices = current.map((service) =>
        service.id === serviceId ? { ...service, [key]: value } : service
      );

      servicesRef.current = nextServices;
      return nextServices;
    });
  }

  function updateServiceLoading(serviceId, action, isLoading) {
    setLoadingStates((current) => ({
      ...current,
      [serviceId]: {
        ...current[serviceId],
        [action]: isLoading,
      },
    }));
  }

  function isServiceLoading(serviceId, action) {
    return Boolean(loadingStates[serviceId]?.[action]);
  }

  function getServiceById(serviceId) {
    return servicesRef.current.find((service) => service.id === serviceId) ?? null;
  }

  function clearStatus() {
    setStatus(createEmptyStatus());
  }

  function showStatus(message, isError = false, errors = []) {
    setStatus({ message, isError, errors });
  }

  async function handleAddService() {
    const nextServices = [...servicesRef.current, createServiceSettings()];

    try {
      await saveSettingsImmediately(nextServices);
    } catch (error) {
      console.error("Не удалось добавить стенд:", error);
      showStatus(`Не удалось добавить стенд: ${error.message}`, true);
    }
  }

  async function handleRemoveService(service) {
    const nextServices = servicesRef.current.filter((item) => item.id !== service.id);

    try {
      await saveSettingsImmediately(nextServices);
      setLoadingStates((current) => {
        const nextLoadingStates = { ...current };
        delete nextLoadingStates[service.id];
        return nextLoadingStates;
      });
    } catch (error) {
      console.error("Не удалось удалить стенд:", error);
      showStatus(
        formatServiceMessage(service, `Не удалось удалить карточку: ${error.message}`),
        true
      );
    }
  }

  async function copyCookies(service, options = {}) {
    const { mode = "manual", retries = 0, retryDelayMs = 500 } = options;
    const isManual = mode === "manual";

    if (isManual) {
      clearStatus();
      updateServiceLoading(service.id, "copy", true);
    }

    const payload = {
      sourceUrl: service.sourceUrl.trim(),
      destinationUrl: service.destinationUrl.trim(),
      keys: service.keys.trim(),
      copyAll: service.copyAll,
    };
    const nextServices = buildUpdatedServices(service.id, payload, servicesRef.current);
    const currentService = getServiceById(service.id) ?? service;
    const savedService = nextServices.find((item) => item.id === service.id) ?? currentService;

    try {
      await saveSettingsImmediately(nextServices);
    } catch (error) {
      if (isManual) {
        updateServiceLoading(service.id, "copy", false);
      }

      if (isManual) {
        showStatus(
          formatServiceMessage(
            currentService,
            `Не удалось сохранить настройки: ${error.message}`
          ),
          true
        );
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
            showStatus(formatServiceMessage(savedService, summary), false, result.errors ?? []);
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
              showStatus(
                formatServiceMessage(savedService, lastError.message ?? String(lastError)),
                true
              );
            }

            return { success: false, error: lastError };
          }
        }
      }
    } finally {
      if (isManual) {
        updateServiceLoading(service.id, "copy", false);
      }
    }

    return {
      success: false,
      error: lastError ?? new Error("Не удалось скопировать cookie автоматически."),
    };
  }

  async function handleClearCurrentPageCookies() {
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
        `Текущая страница: удалено cookie ${removed ?? 0} из ${total ?? 0}${hostLabel}.`,
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

  async function handleAuthorize(service) {
    clearStatus();

    const authValues = getAuthValues(service);
    if (!areAuthFieldsValid(authValues)) {
      showStatus(
        formatServiceMessage(
          service,
          "Заполните все поля авторизации и селекторы."
        ),
        true
      );
      return;
    }

    const selectorValidation = validateSelectors(authValues);
    if (!selectorValidation.valid) {
      showStatus(formatServiceMessage(service, selectorValidation.message), true);
      return;
    }

    const nextServices = buildUpdatedServices(
      service.id,
      {
        authUrl: authValues.url,
        authUsername: authValues.username,
        authPassword: authValues.password,
        authUsernameSelector: authValues.usernameSelector,
        authPasswordSelector: authValues.passwordSelector,
        authSubmitSelector: authValues.submitSelector,
      },
      servicesRef.current
    );
    const savedService = nextServices.find((item) => item.id === service.id) ?? service;

    try {
      await saveSettingsImmediately(nextServices);
    } catch (error) {
      showStatus(
        formatServiceMessage(
          service,
          `Не удалось сохранить настройки авторизации: ${error.message}`
        ),
        true
      );
      return;
    }

    updateServiceLoading(service.id, "authorize", true);

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

      if (shouldAutoCopyAfterAuth(savedService)) {
        const autoCopyResult = await copyCookies(savedService, {
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

      showStatus(formatServiceMessage(savedService, statusText), false, combinedErrors);
    } catch (error) {
      console.error("Ошибка автоматической авторизации:", error);
      showStatus(formatServiceMessage(savedService, error.message ?? String(error)), true);
    } finally {
      updateServiceLoading(service.id, "authorize", false);
    }
  }

  return (
    <main className="popup">
      <div className="popup-header">
        <h1>Cookie Copy Paster</h1>
        <button
          className="secondary-button header-clear-button"
          type="button"
          disabled={clearLoading}
          onClick={handleClearCurrentPageCookies}
        >
          {clearLoading ? (
            <>
              <LoaderCircle className="spin-icon" size={16} />
              <span>Очищаем...</span>
            </>
          ) : (
            <>
              <Trash2 size={16} />
              <span>Очистить cookie</span>
            </>
          )}
        </button>
      </div>

      <div className="service-list">
        {services.map((service, index) => {
          const authValues = getAuthValues(service);
          const copyLoading = isServiceLoading(service.id, "copy");
          const authorizeLoading = isServiceLoading(service.id, "authorize");
          const authorizeDisabled = authorizeLoading || !areAuthFieldsValid(authValues);
          const removeDisabled = copyLoading || authorizeLoading;

          return (
            <Fragment key={service.id}>
              <section className="service-block">
                <div className="service-block-header">
                  <h2 className="service-title">{getServiceTitle(service)}</h2>
                  <button
                    className="card-remove-button"
                    type="button"
                    disabled={removeDisabled}
                    onClick={() => handleRemoveService(service)}
                    aria-label="Удалить карточку"
                    title="Удалить карточку"
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="service-actions">
                  <button
                    className="primary-button authorize-button"
                    type="button"
                    disabled={authorizeDisabled}
                    onClick={() => handleAuthorize(service)}
                  >
                    {authorizeLoading ? "Авторизация..." : "Авторизоваться"}
                  </button>

                  <button
                    className="secondary-button icon-button copy-button"
                    type="button"
                    disabled={copyLoading}
                    onClick={() => copyCookies(service)}
                    aria-label="Скопировать cookie"
                    title="Скопировать cookie"
                  >
                    {copyLoading ? (
                      <LoaderCircle className="spin-icon" size={16} />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                </div>

                <details className="accordion">
                  <summary>
                    <span>Настройки</span>
                    <ChevronDown className="accordion-chevron" size={16} aria-hidden="true" />
                  </summary>
                  <div className="accordion-content">
                    <section className="settings-section">
                      <p className="settings-heading">Копирование cookie</p>

                      <label className="field">
                        <span>URL источника</span>
                        <input
                          type="url"
                          value={service.sourceUrl}
                          onChange={(event) =>
                            updateField(service.id, "sourceUrl", event.target.value)
                          }
                          placeholder="https://example.com"
                        />
                      </label>

                      <label className="field">
                        <span>URL назначения</span>
                        <input
                          type="url"
                          value={service.destinationUrl}
                          onChange={(event) =>
                            updateField(service.id, "destinationUrl", event.target.value)
                          }
                          placeholder="https://target.com"
                        />
                      </label>

                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={service.copyAll}
                          onChange={(event) =>
                            updateField(service.id, "copyAll", event.target.checked)
                          }
                        />
                        <span>Скопировать все cookie</span>
                      </label>

                      <label className="field">
                        <span>Ключи cookie (через запятую)</span>
                        <textarea
                          rows="2"
                          value={service.keys}
                          onChange={(event) =>
                            updateField(service.id, "keys", event.target.value)
                          }
                          placeholder={
                            service.copyAll
                              ? "Список не используется"
                              : "session_id, auth_token"
                          }
                          disabled={service.copyAll}
                        />
                      </label>
                    </section>

                    <section className="settings-section">
                      <p className="settings-heading">Авторизация</p>

                      <label className="field">
                        <span>URL ресурса</span>
                        <input
                          type="url"
                          value={service.authUrl}
                          onChange={(event) =>
                            updateField(service.id, "authUrl", event.target.value)
                          }
                          placeholder="https://example.com/login"
                          autoComplete="url"
                        />
                      </label>

                      <label className="field">
                        <span>Логин</span>
                        <input
                          type="text"
                          value={service.authUsername}
                          onChange={(event) =>
                            updateField(service.id, "authUsername", event.target.value)
                          }
                          placeholder="username"
                          autoComplete="username"
                        />
                      </label>

                      <label className="field">
                        <span>Пароль</span>
                        <input
                          type="password"
                          value={service.authPassword}
                          onChange={(event) =>
                            updateField(service.id, "authPassword", event.target.value)
                          }
                          placeholder="password"
                          autoComplete="current-password"
                        />
                      </label>

                      <label className="field">
                        <span>Селектор поля логина</span>
                        <input
                          type="text"
                          value={service.authUsernameSelector}
                          onChange={(event) =>
                            updateField(
                              service.id,
                              "authUsernameSelector",
                              event.target.value
                            )
                          }
                          placeholder="#login-input"
                        />
                      </label>

                      <label className="field">
                        <span>Селектор поля пароля</span>
                        <input
                          type="text"
                          value={service.authPasswordSelector}
                          onChange={(event) =>
                            updateField(
                              service.id,
                              "authPasswordSelector",
                              event.target.value
                            )
                          }
                          placeholder="#password-input"
                        />
                      </label>

                      <label className="field">
                        <span>Селектор кнопки входа</span>
                        <input
                          type="text"
                          value={service.authSubmitSelector}
                          onChange={(event) =>
                            updateField(service.id, "authSubmitSelector", event.target.value)
                          }
                          placeholder="#login-button"
                        />
                      </label>

                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={service.autoCopyAfterAuth}
                          onChange={(event) =>
                            updateField(
                              service.id,
                              "autoCopyAfterAuth",
                              event.target.checked
                            )
                          }
                        />
                        <span>Автоматически копировать cookie после авторизации</span>
                      </label>
                    </section>
                  </div>
                </details>
              </section>

              {index < services.length - 1 ? (
                <div className="service-divider" aria-hidden="true" />
              ) : null}
            </Fragment>
          );
        })}
      </div>

      <button className="add-service-button" type="button" onClick={handleAddService}>
        +
      </button>

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

function createEmptyStatus() {
  return { message: "", isError: false, errors: [] };
}

function createServiceSettings() {
  return {
    id: createServiceId(),
    ...defaultServiceSettings,
  };
}

function createServiceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `service-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildUpdatedServices(serviceId, updates, services) {
  return services.map((service) =>
    service.id === serviceId ? { ...service, ...updates } : service
  );
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { services: normalizeStoredServices(stored?.[STORAGE_KEY]) };
}

function normalizeStoredServices(storedSettings) {
  if (Array.isArray(storedSettings?.services)) {
    return storedSettings.services.map(normalizeServiceSettings);
  }

  if (storedSettings && typeof storedSettings === "object") {
    return [normalizeServiceSettings(storedSettings)];
  }

  return [createServiceSettings()];
}

function normalizeServiceSettings(service) {
  const normalized = {
    ...defaultServiceSettings,
    ...(service ?? {}),
  };

  return {
    ...normalized,
    id:
      typeof normalized.id === "string" && normalized.id.trim()
        ? normalized.id
        : createServiceId(),
  };
}

async function persistSettings(services) {
  await chrome.storage.local.set({ [STORAGE_KEY]: { services } });
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

function shouldAutoCopyAfterAuth(service) {
  if (!service.autoCopyAfterAuth) {
    return false;
  }

  return Boolean(service.sourceUrl.trim() && service.destinationUrl.trim());
}

function getAuthValues(service) {
  return {
    url: service.authUrl.trim(),
    username: service.authUsername,
    password: service.authPassword,
    usernameSelector: service.authUsernameSelector.trim(),
    passwordSelector: service.authPasswordSelector.trim(),
    submitSelector: service.authSubmitSelector.trim(),
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

function getServiceTitle(service) {
  const resourceUrl = String(service.authUrl ?? "").trim();

  if (!resourceUrl) {
    return "Новый стенд";
  }

  try {
    return new URL(resourceUrl).host || "Новый стенд";
  } catch {
    return resourceUrl;
  }
}

function formatServiceMessage(service, message) {
  return `${getServiceTitle(service)}: ${message}`;
}
