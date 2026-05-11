// Optional helpers (if you drop them in your extension root):
//  - tldts.min.js for robust hostname parsing
//  - browser-polyfill.min.js for cross-browser 'browser.*' promises
try { importScripts('browser-polyfill.min.js'); } catch (_e) { /* optional helper, absent in some builds */ }
try { importScripts('tldts.min.js'); } catch (_e) { /* optional helper, absent in some builds */ }

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_RULES = [{ pattern: "example.com", clearCookies: false, clearStorage: false }];

// --- i18n helpers
const i18n = (k, subs = []) => {
  try { return chrome.i18n.getMessage(k, subs) || k; } catch { return k; }
};

// --- hostname extraction (prefer tldts)
function getHost(input) {
  try {
    if (self.tldts?.getHostname) {
      const h = self.tldts.getHostname(input);
      if (h) return h;
    }
  } catch (_e) { /* tldts unavailable */ }
  try {
    const u = input.includes("://") ? new URL(input) : new URL("https://" + input);
    return u.hostname;
  } catch { return null; }
}

const isWebUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

// --- rule cache (snappy matching)
let ruleCache = []; // [{pattern, clearCookies, clearStorage, test(url)}]

// Shared validation used by both makeTester and the import path so that a
// pattern rejected at match time is also rejected at import time.

// Stack-based scan: returns true if any group that contains a quantifier
// is itself followed by a repetition quantifier (+, *, {) — catches
// (a+)+, ((a)+)+, ([a-z]+)* etc. while allowing safe patterns like
// (?:https?:\/\/)? where ? is group syntax or a single-optional outer.
function hasNestedQuantifier(raw) {
  const isQ = (ch) => ch === "+" || ch === "*" || ch === "?" || ch === "{";
  // Only + * { on the outer group risk exponential backtracking; ? (zero-or-one) is safe
  const isRepeat = (ch) => ch === "+" || ch === "*" || ch === "{";
  let depth = 0;
  const hasQ = [false]; // hasQ[depth] — did this group see a quantifier?
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; } // skip escaped char
    if (ch === "[") { // skip character class entirely
      i++;
      while (i < raw.length && raw[i] !== "]") { if (raw[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "(") {
      hasQ[++depth] = false;
      if (raw[i + 1] === "?") i++; // skip group-syntax ? in (?:…), (?=…), (?!…), (?<=…)
    } else if (ch === ")") {
      if (depth > 0) {
        const inner = hasQ[depth--];
        if (inner && isRepeat(raw[i + 1] || "")) return true;
      }
    } else if (depth > 0 && isQ(ch)) { hasQ[depth] = true; }
  }
  return false;
}

function isPatternSafe(pat) {
  if (!pat || typeof pat !== "string") return false;
  if (!pat.startsWith("regex:")) return true; // hostname/wildcard/URL patterns have no regex safety constraints
  const raw = pat.slice(6);
  if (raw.length > 200) return false;
  // Adjacent quantifiers: a+*, a**, a{3}* etc.
  // Strip escape sequences first so \++ (escaped literal, then quantifier) isn't falsely rejected.
  // Second token excludes ? so that lazy quantifiers (*?, +?, ??, {n}?) are allowed.
  if (/([+*?]|\{[^}]+\})([+*]|\{)/.test(raw.replace(/\\./g, "X"))) return false;
  // Nested quantifiers at any depth: (a+)+, ((a)+)+, ([a-z]+)* etc.
  if (hasNestedQuantifier(raw)) return false;
  try { new RegExp(raw); return true; } catch (_e) { return false; }
}

function makeTester(pat) {
  if (!isPatternSafe(pat)) return () => false;

  // regex:
  if (pat.startsWith("regex:")) {
    const re = new RegExp(pat.slice(6)); // safe: validated by isPatternSafe
    return (url) => isWebUrl(url) && re.test(url);
  }

  // wildcard / full-url-ish:
  if (pat.includes("://") || pat.includes("*") || pat.includes("/")) {
    try {
      const re = wildcardToRegex(pat);
      return (url) => isWebUrl(url) && re.test(url);
    } catch { /* fall-through */ }
  }

  // host suffix matcher
  const want = pat.toLowerCase().replace(/^\*\./, "");
  return (url) => {
    if (!isWebUrl(url)) return false;
    const h = (getHost(url) || "").toLowerCase();
    return h === want || h.endsWith("." + want);
  };
}

async function rebuildCache() {
  const { rules = [] } = await chrome.storage.sync.get("rules");
  ruleCache = (Array.isArray(rules) ? rules : []).map((r) => ({
    pattern: r.pattern,
    clearCookies: !!r.clearCookies,
    clearStorage: !!r.clearStorage,
    test: makeTester(r.pattern)
  }));
}

// Kick off cache population immediately so event handlers don't race a cold
// service-worker restart (MV3 SWs can be woken by history/navigation events
// without firing onInstalled or onStartup).
const cacheReady = rebuildCache();

chrome.runtime.onInstalled.addListener(async () => {
  // migrate old blocklist -> rules
  const cur = await chrome.storage.sync.get(null);
  if (!Array.isArray(cur.rules)) {
    const rules = Array.isArray(cur.blocklist)
      ? cur.blocklist.map((p) => ({ pattern: String(p || "").trim(), clearCookies: false, clearStorage: false })).filter((r) => r.pattern)
      : DEFAULT_RULES;
    await chrome.storage.sync.set({ rules });
  }

  await rebuildCache();

  // context menus
  chrome.contextMenus.create({
    id: "add-site",
    title: i18n("ctxAddSite"),
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "add-link-site",
    title: i18n("ctxAddLinkSite"),
    contexts: ["link"]
  });

  // badge color (green)
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
});

// Rebuild cache when Chrome restarts and revives the service worker
chrome.runtime.onStartup.addListener(rebuildCache);

chrome.storage.onChanged.addListener(async (chg, area) => {
  if (area === "sync" && chg.rules) {
    await rebuildCache();
    // Refresh badge for all active tabs so the indicator stays current
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map((t) => t.id ? updateBadgeForTab(t.id, t.url || "") : Promise.resolve()));
  }
});

// --- context menu handlers
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "add-site" && tab?.url) {
      await mergeRuleForUrl(tab.url);
      await updateBadgeForTab(tab.id, tab.url);
    } else if (info.menuItemId === "add-link-site" && info.linkUrl) {
      await mergeRuleForUrl(info.linkUrl);
    }
  } catch (e) { await recordError(e, "contextMenu"); }
});

async function mergeRuleForUrl(url) {
  const host = getHost(url);
  if (!host) return;
  const data = await chrome.storage.sync.get("rules");
  const rules = Array.isArray(data.rules) ? data.rules : [];
  if (!rules.some((r) => r.pattern === host)) {
    rules.unshift({ pattern: host, clearCookies: false, clearStorage: false });
    await chrome.storage.sync.set({ rules });
  }
}

// --- pause state (local)
const now = () => Date.now();
async function getPauseState() {
  const { pauseUntil = 0, hostPauses = {} } = await chrome.storage.local.get(["pauseUntil", "hostPauses"]);
  return { pauseUntil: Number(pauseUntil) || 0, hostPauses: hostPauses || {} };
}
const isGloballyPaused = (pauseUntil) => pauseUntil > now();
const isHostPaused = (host, hostPauses) => Number(hostPauses?.[host] || 0) > now();

async function isUrlPaused(url) {
  if (!isWebUrl(url)) return true; // ignore non-web
  const host = getHost(url);
  const { pauseUntil, hostPauses } = await getPauseState();
  return isGloballyPaused(pauseUntil) || (host && isHostPaused(host, hostPauses));
}

// --- instant clean on visit
chrome.history.onVisited.addListener(async (item) => {
  try {
    await cacheReady;
    if (await isUrlPaused(item.url)) return;
    const matched = ruleCache.filter((r) => r.test(item.url));
    if (!matched.length) return;
    await chrome.history.deleteUrl({ url: item.url });
    await maybeZapSiteData(item.url, matched);
  } catch (e) { await recordError(e, "history.onVisited"); }
});

// --- also catch committed navigations
chrome.webNavigation.onCommitted.addListener(async ({ tabId, url }) => {
  try {
    await cacheReady;
    if (!isWebUrl(url) || (await isUrlPaused(url))) return;
    const matched = ruleCache.filter((r) => r.test(url));
    if (!matched.length) return;
    try { await chrome.history.deleteUrl({ url }); } catch (_e) { /* history entry may already be gone */ }
    await maybeZapSiteData(url, matched);
    await updateBadgeForTab(tabId, url);
  } catch (e) { await recordError(e, "webNavigation.onCommitted"); }
});

// --- badge logic (• when matched, ⏸ when paused)
async function updateBadgeForTab(tabId, url) {
  try {
    const { pauseUntil, hostPauses } = await getPauseState();
    if (isGloballyPaused(pauseUntil) || (url && isHostPaused(getHost(url), hostPauses))) {
      await chrome.action.setBadgeText({ tabId, text: "⏸" });
      return;
    }
    const isMatch = isWebUrl(url) && ruleCache.some((r) => r.test(url));
    await chrome.action.setBadgeText({ tabId, text: isMatch ? "•" : "" });
  } catch (e) { await recordError(e, "updateBadge"); }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    await updateBadgeForTab(tabId, changeInfo.url || tab?.url || "");
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await updateBadgeForTab(tabId, tab?.url || "");
});

// --- messaging (popup)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // test match (pauses respected)
    if (msg?.type === "TEST_MATCH" && typeof msg.url === "string") {
      if (await isUrlPaused(msg.url)) { sendResponse({ ok: true, matched: [] }); return; }
      sendResponse({ ok: true, matched: ruleCache.filter((r) => r.test(msg.url)) });
      return;
    }

    // add the current host (merge)
    if (msg?.type === "ADD_HOST" && typeof msg.url === "string") {
      await mergeRuleForUrl(msg.url);
      if (msg.tabId) await updateBadgeForTab(msg.tabId, msg.url);
      sendResponse({ ok: true, host: getHost(msg.url) });
      return;
    }

    // import (always MERGE & de-dup)
    if (msg?.type === "IMPORT_RULES" && msg?.payload) {
      try {
        const inc = Array.isArray(msg.payload.rules) ? msg.payload.rules : [];
        if (!inc.length) { sendResponse({ ok: true }); return; }

        const cur = await chrome.storage.sync.get("rules");
        const map = new Map();
        (Array.isArray(cur.rules) ? cur.rules : []).forEach((r) => map.set(r.pattern, r));
        let rejected = 0;
        inc.forEach((r) => {
          const p = String(r?.pattern || "").trim();
          if (!p) return;
          if (!isPatternSafe(p)) { rejected++; return; }
          const prev = map.get(p) || { pattern: p, clearCookies: false, clearStorage: false };
          map.set(p, {
            pattern: p,
            clearCookies: r.clearCookies ?? prev.clearCookies ?? false,
            clearStorage: r.clearStorage ?? prev.clearStorage ?? false
          });
        });
        await chrome.storage.sync.set({ rules: Array.from(map.values()) });
        await rebuildCache();
        sendResponse({ ok: true, rejected });
      } catch (e) { await recordError(e, "IMPORT_RULES"); sendResponse({ ok: false }); }
      return;
    }

    // export
    if (msg?.type === "EXPORT_RULES") {
      const { rules = [] } = await chrome.storage.sync.get("rules");
      sendResponse({ ok: true, payload: { rules, _version: VERSION } });
      return;
    }

    // pause API
    if (msg?.type === "SET_GLOBAL_PAUSE") {
      const until = now() + Math.max(1, Number(msg.ms));
      await chrome.storage.local.set({ pauseUntil: until });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await updateBadgeForTab(tab.id, tab.url);
      sendResponse({ ok: true, pauseUntil: until });
      return;
    }
    if (msg?.type === "CLEAR_GLOBAL_PAUSE") {
      await chrome.storage.local.set({ pauseUntil: 0 });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await updateBadgeForTab(tab.id, tab.url);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "SET_HOST_PAUSE" && typeof msg.host === "string") {
      const { hostPauses = {} } = await chrome.storage.local.get("hostPauses");
      hostPauses[msg.host] = now() + Math.max(1, Number(msg.ms));
      await chrome.storage.local.set({ hostPauses });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await updateBadgeForTab(tab.id, tab.url);
      sendResponse({ ok: true, host: msg.host, until: hostPauses[msg.host] });
      return;
    }
    if (msg?.type === "CLEAR_HOST_PAUSE" && typeof msg.host === "string") {
      const { hostPauses = {} } = await chrome.storage.local.get("hostPauses");
      delete hostPauses[msg.host];
      await chrome.storage.local.set({ hostPauses });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await updateBadgeForTab(tab.id, tab.url);
      sendResponse({ ok: true });
      return;
    }

    // pause state for popup display
    if (msg?.type === "GET_PAUSE_STATE") {
      const url = typeof msg.url === "string" ? msg.url : "";
      const host = url ? getHost(url) : null;
      const { pauseUntil, hostPauses } = await getPauseState();
      const hostUntil = host ? (Number(hostPauses?.[host] || 0) || 0) : 0;
      sendResponse({ ok: true, globalUntil: pauseUntil, host, hostUntil, now: now() });
      return;
    }

    // errors
    if (msg?.type === "GET_LAST_ERROR") {
      const { lastError = null } = await chrome.storage.local.get("lastError");
      sendResponse({ ok: true, lastError });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })();
  return true;
});

// --- cleanup helpers
function wildcardToRegex(pat) {
  let pattern = pat.trim();
  let schemeGroup = "(https?:)";
  if (pattern.includes("://")) {
    pattern = pattern.replace(/^\*:/, "https?:");
    schemeGroup = pattern.split("://", 1)[0].replace(/[-/\\^$+?.()|[\]{}]/g, "").replace("*", "https?") + ":";
    pattern = pattern.replace(/^[^:]+:/, schemeGroup);
  } else {
    pattern = schemeGroup + "//" + pattern;
  }
  const esc = (s) => s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  let rx = esc(pattern).replace(/\\\*\\\./g, "([^.]+\\.)?").replace(/\\\*/g, ".*");
  if (!rx.includes("\\/")) rx += "(?:\\/.*)?";
  return new RegExp("^" + rx + "$", "i");
}

async function maybeZapSiteData(url, matchedRules) {
  const cookieOrigins = new Set();
  const storageOrigins = new Set();
  try {
    const origin = new URL(url).origin;
    if (matchedRules.some((m) => m.clearCookies)) cookieOrigins.add(origin);
    if (matchedRules.some((m) => m.clearStorage)) storageOrigins.add(origin);
  } catch (_e) { /* invalid URL, nothing to clear */ }

  if (cookieOrigins.size) {
    try { await chrome.browsingData.removeCookies({ origins: [...cookieOrigins] }); }
    catch (e) { await recordError(e, "removeCookies"); }
  }
  if (storageOrigins.size) {
    try {
      await chrome.browsingData.remove(
        { origins: [...storageOrigins] },
        { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, webSQL: true, fileSystems: true }
      );
    } catch (e) { await recordError(e, "removeSiteData"); }
  }
}

async function recordError(err, where) {
  try {
    const payload = { where, message: String(err?.message || err), time: Date.now() };
    await chrome.storage.local.set({ lastError: payload });
  } catch { /* ignore */ }
}
