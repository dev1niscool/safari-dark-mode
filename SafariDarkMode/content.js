(() => {
  "use strict";

  if (globalThis.__safariDarkModeLoaded) {
    return;
  }
  globalThis.__safariDarkModeLoaded = true;

  const extensionAPI = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const DEFAULT_SETTINGS = Object.freeze({
    globalEnabled: true,
    excludedHosts: []
  });
  const OVERRIDE_ATTRIBUTES = [
    "data-sdm-bg",
    "data-sdm-fg",
    "data-sdm-border",
    "data-sdm-svg-fill",
    "data-sdm-svg-stroke"
  ];
  const OVERRIDE_PROPERTIES = [
    "--sdm-bg",
    "--sdm-fg",
    "--sdm-border-top",
    "--sdm-border-right",
    "--sdm-border-bottom",
    "--sdm-border-left",
    "--sdm-svg-fill",
    "--sdm-svg-stroke"
  ];
  const REPROCESS_ATTRIBUTES = ["class", "style", "color", "bgcolor"];

  let settings = { ...DEFAULT_SETTINGS };
  let runID = 0;
  let mutationObserver;
  const selfAuthoredStyles = new WeakMap();
  let state = {
    active: false,
    pageKind: "checking",
    reason: "Checking this page",
    sampledLuminance: null
  };

  function storageGet(defaults) {
    if (!extensionAPI?.storage?.local) {
      return Promise.resolve(defaults);
    }

    if (globalThis.browser) {
      return extensionAPI.storage.local.get(defaults);
    }

    return new Promise((resolve) => {
      extensionAPI.storage.local.get(defaults, (result) => {
        resolve(result ?? defaults);
      });
    });
  }

  function normalizeSettings(value) {
    return {
      globalEnabled: value?.globalEnabled !== false,
      excludedHosts: Array.isArray(value?.excludedHosts)
        ? value.excludedHosts.filter((host) => typeof host === "string")
        : []
    };
  }

  function hostIsExcluded(hostname) {
    return settings.excludedHosts.some((excludedHost) =>
      hostname === excludedHost || hostname.endsWith(`.${excludedHost}`)
    );
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function waitForPage() {
    if (document.readyState === "loading") {
      await new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      });
    }

    // Allow layout and author styles to settle before sampling the page.
    await nextFrame();
    await nextFrame();
  }

  function parseChannel(value) {
    if (value.endsWith("%")) {
      return Math.max(0, Math.min(255, Number.parseFloat(value) * 2.55));
    }
    return Math.max(0, Math.min(255, Number.parseFloat(value)));
  }

  function parseAlpha(value) {
    if (!value) {
      return 1;
    }
    if (value.endsWith("%")) {
      return Math.max(0, Math.min(1, Number.parseFloat(value) / 100));
    }
    return Math.max(0, Math.min(1, Number.parseFloat(value)));
  }

  function parseColor(value) {
    if (!value || value === "transparent" || value === "none") {
      return { r: 0, g: 0, b: 0, a: 0 };
    }

    const hexMatch = value.match(/^#([\da-f]{3,8})$/i);
    if (hexMatch) {
      let hex = hexMatch[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = [...hex].map((character) => character.repeat(2)).join("");
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: Number.parseInt(hex.slice(0, 2), 16),
          g: Number.parseInt(hex.slice(2, 4), 16),
          b: Number.parseInt(hex.slice(4, 6), 16),
          a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
        };
      }
    }

    const rgbMatch = value.match(/^rgba?\((.*)\)$/i);
    if (rgbMatch) {
      const [channelsPart, alphaPart] = rgbMatch[1].split("/").map((part) => part.trim());
      const channels = channelsPart.split(/[\s,]+/).filter(Boolean);
      if (channels.length >= 3) {
        const legacyAlpha = channels.length >= 4 ? channels[3] : undefined;
        return {
          r: parseChannel(channels[0]),
          g: parseChannel(channels[1]),
          b: parseChannel(channels[2]),
          a: parseAlpha(alphaPart ?? legacyAlpha)
        };
      }
    }

    const srgbMatch = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i);
    if (srgbMatch) {
      return {
        r: Number.parseFloat(srgbMatch[1]) * 255,
        g: Number.parseFloat(srgbMatch[2]) * 255,
        b: Number.parseFloat(srgbMatch[3]) * 255,
        a: parseAlpha(srgbMatch[4])
      };
    }

    return null;
  }

  function linearChannel(channel) {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  }

  function luminance(color) {
    return (
      0.2126 * linearChannel(color.r) +
      0.7152 * linearChannel(color.g) +
      0.0722 * linearChannel(color.b)
    );
  }

  function composite(foreground, background) {
    const alpha = foreground.a + background.a * (1 - foreground.a);
    if (alpha === 0) {
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    return {
      r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
      g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
      b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
      a: alpha
    };
  }

  function rgbToHsl(color) {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
      if (max === r) hue = ((g - b) / delta) % 6;
      if (max === g) hue = (b - r) / delta + 2;
      if (max === b) hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }

    const lightness = (max + min) / 2;
    const saturation = delta === 0
      ? 0
      : delta / (1 - Math.abs(2 * lightness - 1));

    return { h: hue, s: saturation, l: lightness };
  }

  function hslToRgb({ h, s, l, a = 1 }) {
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const section = h / 60;
    const x = chroma * (1 - Math.abs((section % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;

    if (section >= 0 && section < 1) [r, g] = [chroma, x];
    else if (section < 2) [r, g] = [x, chroma];
    else if (section < 3) [g, b] = [chroma, x];
    else if (section < 4) [g, b] = [x, chroma];
    else if (section < 5) [r, b] = [x, chroma];
    else [r, b] = [chroma, x];

    const match = l - chroma / 2;
    return {
      r: (r + match) * 255,
      g: (g + match) * 255,
      b: (b + match) * 255,
      a
    };
  }

  function serializeColor(color) {
    const red = Math.round(color.r);
    const green = Math.round(color.g);
    const blue = Math.round(color.b);
    const alpha = Math.round(color.a * 1000) / 1000;
    return alpha < 1
      ? `rgba(${red}, ${green}, ${blue}, ${alpha})`
      : `rgb(${red}, ${green}, ${blue})`;
  }

  function darkBackground(color) {
    const hsl = rgbToHsl(color);
    return hslToRgb({
      h: hsl.h,
      s: Math.min(hsl.s, 0.46),
      l: 0.09 + (1 - hsl.l) * 0.15,
      a: color.a
    });
  }

  function lightForeground(color) {
    const hsl = rgbToHsl(color);
    return hslToRgb({
      h: hsl.h,
      s: Math.min(hsl.s, 0.68),
      l: Math.max(0.76, 0.9 - hsl.l * 0.16),
      a: color.a
    });
  }

  function mutedBorder(color) {
    const hsl = rgbToHsl(color);
    const isDark = luminance(color) < 0.42;
    return hslToRgb({
      h: hsl.h,
      s: Math.min(hsl.s, 0.45),
      l: isDark ? 0.45 : 0.27,
      a: color.a
    });
  }

  function effectiveBackground(element) {
    const layers = [];
    let current = element;

    while (current instanceof Element) {
      const background = parseColor(getComputedStyle(current).backgroundColor);
      if (background && background.a > 0) {
        layers.push(background);
        if (background.a >= 0.98) break;
      }
      current = current.parentElement;
    }

    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      result = composite(layers[index], result);
    }
    return result;
  }

  function authorSuggestsDark() {
    const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]')?.content?.toLowerCase() ?? "";
    const themeColor = document.querySelector('meta[name="theme-color"]')?.content;
    const parsedThemeColor = parseColor(themeColor);
    const rootColorScheme = (getComputedStyle(root).colorScheme ?? "").toLowerCase().trim();

    return (
      colorSchemeMeta.split(/\s+/)[0] === "dark" ||
      rootColorScheme.split(/\s+/)[0] === "dark" ||
      (parsedThemeColor && luminance(parsedThemeColor) < 0.25)
    );
  }

  function inspectPageTheme() {
    const samples = [];
    const columns = 5;
    const rows = 4;
    const width = Math.max(document.documentElement.clientWidth, 1);
    const height = Math.max(document.documentElement.clientHeight, 1);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(width - 1, ((column + 0.5) / columns) * width);
        const y = Math.min(height - 1, ((row + 0.5) / rows) * height);
        const element = document.elementFromPoint(x, y);
        if (element) {
          samples.push(luminance(effectiveBackground(element)));
        }
      }
    }

    const bodySurface = document.body
      ? luminance(effectiveBackground(document.body))
      : 1;
    samples.push(bodySurface);

    const average = samples.reduce((total, value) => total + value, 0) / samples.length;
    const darkRatio = samples.filter((value) => value < 0.34).length / samples.length;
    const suggested = authorSuggestsDark();
    const isDark = bodySurface < 0.28 || darkRatio >= 0.64 || (suggested && darkRatio >= 0.43);

    return {
      isDark,
      average,
      reason: isDark
        ? "This website is already dark"
        : "A light website was detected"
    };
  }

  function clearElementOverrides(element) {
    for (const attribute of OVERRIDE_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
    for (const property of OVERRIDE_PROPERTIES) {
      element.style.removeProperty(property);
    }
  }

  function setOverride(element, attribute, property, color) {
    element.setAttribute(attribute, "");
    element.style.setProperty(property, serializeColor(color));
  }

  function processElement(element) {
    const originalInlineStyle = element.getAttribute("style");
    clearElementOverrides(element);
    const computed = getComputedStyle(element);

    const background = parseColor(computed.backgroundColor);
    if (background && background.a > 0.015 && luminance(background) > 0.43) {
      setOverride(element, "data-sdm-bg", "--sdm-bg", darkBackground(background));
    }

    const foreground = parseColor(computed.color);
    if (foreground && foreground.a > 0.05 && luminance(foreground) < 0.5) {
      setOverride(element, "data-sdm-fg", "--sdm-fg", lightForeground(foreground));
    }

    const borderNames = ["Top", "Right", "Bottom", "Left"];
    const borderColors = borderNames.map((side) => parseColor(computed[`border${side}Color`]));
    const hasVisibleBorder = borderNames.some((side) =>
      Number.parseFloat(computed[`border${side}Width`]) > 0 && computed[`border${side}Style`] !== "none"
    );

    if (hasVisibleBorder && borderColors.some((color) => color && color.a > 0.05)) {
      element.setAttribute("data-sdm-border", "");
      borderColors.forEach((color, index) => {
        if (color) {
          element.style.setProperty(
            `--sdm-border-${borderNames[index].toLowerCase()}`,
            serializeColor(mutedBorder(color))
          );
        }
      });
    }

    if (element instanceof SVGElement) {
      const fill = parseColor(computed.fill);
      if (fill && fill.a > 0.05 && luminance(fill) < 0.48) {
        setOverride(element, "data-sdm-svg-fill", "--sdm-svg-fill", lightForeground(fill));
      }

      const stroke = parseColor(computed.stroke);
      if (stroke && stroke.a > 0.05 && luminance(stroke) < 0.48) {
        setOverride(element, "data-sdm-svg-stroke", "--sdm-svg-stroke", lightForeground(stroke));
      }
    }

    // The observer watches author changes to the style attribute. Remember our
    // own final value so those writes do not recursively trigger more work.
    const updatedInlineStyle = element.getAttribute("style");
    if (updatedInlineStyle !== originalInlineStyle) {
      selfAuthoredStyles.set(element, updatedInlineStyle);
    } else {
      selfAuthoredStyles.delete(element);
    }
  }

  function processTree(startNode, currentRunID) {
    return new Promise((resolve) => {
      const walker = document.createTreeWalker(startNode, NodeFilter.SHOW_ELEMENT);
      let current = walker.currentNode;

      function processChunk(deadline) {
        let processed = 0;
        while (
          current &&
          currentRunID === runID &&
          processed < 350 &&
          (!deadline || deadline.timeRemaining() > 1)
        ) {
          processElement(current);
          current = walker.nextNode();
          processed += 1;
        }

        if (!current || currentRunID !== runID) {
          resolve(currentRunID === runID);
          return;
        }

        scheduleIdle(processChunk);
      }

      scheduleIdle(processChunk);
    });
  }

  function scheduleIdle(callback) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(callback, { timeout: 80 });
    } else {
      setTimeout(() => callback(null), 0);
    }
  }

  function stopObserving() {
    mutationObserver?.disconnect();
    mutationObserver = undefined;
  }

  function startObserving() {
    stopObserving();
    mutationObserver = new MutationObserver((mutations) => {
      if (!state.active) return;

      scheduleIdle(() => {
        const seen = new Set();
        const ignoredSelfStyles = new Set();
        for (const mutation of mutations) {
          if (mutation.type === "attributes" && mutation.target instanceof Element) {
            if (
              mutation.attributeName === "style" &&
              selfAuthoredStyles.get(mutation.target) === mutation.target.getAttribute("style")
            ) {
              ignoredSelfStyles.add(mutation.target);
              continue;
            }
            seen.add(mutation.target);
          }
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              seen.add(node);
              node.querySelectorAll("*").forEach((child) => seen.add(child));
            }
          }
        }
        ignoredSelfStyles.forEach((element) => selfAuthoredStyles.delete(element));
        seen.forEach(processElement);
      });
    });

    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: REPROCESS_ATTRIBUTES
    });
  }

  function deactivate(pageKind, reason) {
    runID += 1;
    stopObserving();
    root.removeAttribute("data-sdm-active");
    root.removeAttribute("data-sdm-processing");
    state = {
      active: false,
      pageKind,
      reason,
      sampledLuminance: state.sampledLuminance
    };
  }

  async function evaluateAndApply() {
    const currentRunID = ++runID;
    stopObserving();
    root.removeAttribute("data-sdm-active");
    root.setAttribute("data-sdm-processing", "true");

    if (!settings.globalEnabled) {
      deactivate("disabled", "The extension is turned off");
      return state;
    }

    if (hostIsExcluded(location.hostname)) {
      deactivate("excluded", "Dark mode is off for this website");
      return state;
    }

    const inspection = inspectPageTheme();
    state.sampledLuminance = Math.round(inspection.average * 1000) / 1000;

    if (inspection.isDark) {
      deactivate("already-dark", inspection.reason);
      return state;
    }

    state = {
      active: false,
      pageKind: "processing",
      reason: "Darkening this website",
      sampledLuminance: state.sampledLuminance
    };

    const completed = await processTree(document.documentElement, currentRunID);
    if (!completed || currentRunID !== runID) {
      return state;
    }

    root.removeAttribute("data-sdm-processing");
    root.setAttribute("data-sdm-active", "true");
    state = {
      active: true,
      pageKind: "light-darkened",
      reason: "This light website is now dark",
      sampledLuminance: state.sampledLuminance
    };
    startObserving();
    return state;
  }

  function statusPayload() {
    return {
      ...state,
      host: location.hostname,
      globalEnabled: settings.globalEnabled,
      siteEnabled: !hostIsExcluded(location.hostname)
    };
  }

  async function reloadSettings() {
    settings = normalizeSettings(await storageGet(DEFAULT_SETTINGS));
    await evaluateAndApply();
    return statusPayload();
  }

  extensionAPI?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === "sdm:get-status") {
      sendResponse?.(statusPayload());
      return undefined;
    }

    if (message?.type === "sdm:settings-changed") {
      reloadSettings().then((status) => sendResponse?.(status));
      return true;
    }

    return undefined;
  });

  extensionAPI?.storage?.onChanged?.addListener((_changes, areaName) => {
    if (areaName === "local") {
      reloadSettings();
    }
  });

  (async () => {
    settings = normalizeSettings(await storageGet(DEFAULT_SETTINGS));
    await waitForPage();
    await evaluateAndApply();
  })();
})();
