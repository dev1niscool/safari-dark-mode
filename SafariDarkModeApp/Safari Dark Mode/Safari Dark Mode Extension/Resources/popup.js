(() => {
  "use strict";

  const extensionAPI = globalThis.browser ?? globalThis.chrome;
  const DEFAULT_SETTINGS = Object.freeze({
    globalEnabled: true,
    excludedHosts: []
  });

  const globalToggle = document.querySelector("#global-toggle");
  const siteToggle = document.querySelector("#site-toggle");
  const siteName = document.querySelector("#site-name");
  const statusDot = document.querySelector("#status-dot");
  const statusTitle = document.querySelector("#status-title");
  const statusDetail = document.querySelector("#status-detail");

  let activeTab;
  let hostname = "";
  let settings = { ...DEFAULT_SETTINGS };

  function storageGet(defaults) {
    if (globalThis.browser) {
      return extensionAPI.storage.local.get(defaults);
    }
    return new Promise((resolve) => {
      extensionAPI.storage.local.get(defaults, (result) => resolve(result ?? defaults));
    });
  }

  function storageSet(value) {
    if (globalThis.browser) {
      return extensionAPI.storage.local.set(value);
    }
    return new Promise((resolve) => extensionAPI.storage.local.set(value, resolve));
  }

  function queryActiveTab() {
    if (globalThis.browser) {
      return extensionAPI.tabs.query({ active: true, currentWindow: true });
    }
    return new Promise((resolve) => {
      extensionAPI.tabs.query({ active: true, currentWindow: true }, resolve);
    });
  }

  function sendMessage(tabID, message) {
    if (globalThis.browser) {
      return extensionAPI.tabs.sendMessage(tabID, message, { frameId: 0 });
    }
    return new Promise((resolve, reject) => {
      extensionAPI.tabs.sendMessage(tabID, message, { frameId: 0 }, (response) => {
        const error = extensionAPI.runtime.lastError;
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  function normalizedSettings(value) {
    return {
      globalEnabled: value?.globalEnabled !== false,
      excludedHosts: Array.isArray(value?.excludedHosts)
        ? value.excludedHosts.filter((host) => typeof host === "string" && host.length > 0)
        : []
    };
  }

  function hostIsExcluded() {
    return settings.excludedHosts.some((excludedHost) =>
      hostname === excludedHost || hostname.endsWith(`.${excludedHost}`)
    );
  }

  function setStatus(title, detail, kind = "checking") {
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
    statusDot.className = `status-dot ${kind}`;
  }

  function applySettingsToControls() {
    const excluded = hostIsExcluded();
    globalToggle.checked = settings.globalEnabled;
    siteToggle.checked = !excluded;
    siteToggle.disabled = !settings.globalEnabled || !hostname;
  }

  function renderStatus(status) {
    if (!status) {
      setStatus(
        "Unavailable on this page",
        "Safari blocks extensions on some built-in pages."
      );
      return;
    }

    if (status.pageKind === "light-darkened") {
      setStatus("Dark mode is active", "A light page was detected and darkened.", "active");
    } else if (status.pageKind === "already-dark") {
      setStatus("Original dark theme kept", "This page was already dark, so it was not changed.", "preserved");
    } else if (status.pageKind === "processing") {
      setStatus("Darkening this page…", "Large pages can take a moment.", "active");
    } else if (status.pageKind === "excluded") {
      setStatus("Off for this website", "Turn on “This website” to enable it here.");
    } else if (status.pageKind === "disabled") {
      setStatus("Dark mode is off", "Turn on Dark mode to use automatic detection.");
    } else {
      setStatus("Checking this page…", "Theme detection is automatic.");
    }
  }

  async function refreshStatus() {
    if (!activeTab?.id) {
      renderStatus(null);
      return;
    }
    try {
      renderStatus(await sendMessage(activeTab.id, { type: "sdm:get-status" }));
    } catch (_error) {
      renderStatus(null);
    }
  }

  async function notifyPage() {
    if (!activeTab?.id) return;
    try {
      const status = await sendMessage(activeTab.id, { type: "sdm:settings-changed" });
      renderStatus(status);
    } catch (_error) {
      renderStatus(null);
    }
  }

  globalToggle.addEventListener("change", async () => {
    settings.globalEnabled = globalToggle.checked;
    await storageSet({ globalEnabled: settings.globalEnabled });
    applySettingsToControls();
    await notifyPage();
  });

  siteToggle.addEventListener("change", async () => {
    const excludedHosts = new Set(settings.excludedHosts);
    if (siteToggle.checked) {
      for (const excludedHost of excludedHosts) {
        if (hostname === excludedHost || hostname.endsWith(`.${excludedHost}`)) {
          excludedHosts.delete(excludedHost);
        }
      }
    } else {
      excludedHosts.add(hostname);
    }
    settings.excludedHosts = [...excludedHosts].sort();
    await storageSet({ excludedHosts: settings.excludedHosts });
    applySettingsToControls();
    await notifyPage();
  });

  (async () => {
    settings = normalizedSettings(await storageGet(DEFAULT_SETTINGS));
    [activeTab] = await queryActiveTab();

    try {
      const url = new URL(activeTab?.url ?? "");
      if (url.protocol === "http:" || url.protocol === "https:") {
        hostname = url.hostname;
      }
    } catch (_error) {
      hostname = "";
    }

    siteName.textContent = hostname || "Unavailable on this page";
    applySettingsToControls();
    await refreshStatus();
  })();
})();
