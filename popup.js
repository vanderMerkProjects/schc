const sendMessage = (payload) => new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
const $ = (id) => document.getElementById(id);

// Optional tldts in popup
function getHost(input) {
  try {
    if (window.tldts?.getHostname) {
      const h = window.tldts.getHostname(input);
      if (h) return h;
    }
  } catch {}
  try {
    const u = input.includes("://") ? new URL(input) : new URL("https://" + input);
    return u.hostname;
  } catch { return null; }
}

let currentUrl = null;
let currentHost = null;
let rules = [];
let lastErrorCache = null;
let statusTimer = null;

// i18n: fill elements with data-i18n
function i18nFill() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  i18nFill();
  $("version").textContent = "v" + chrome.runtime.getManifest().version;

  const all = await chrome.storage.sync.get(["rules", "blocklist"]);
  rules = Array.isArray(all.rules)
    ? all.rules
    : Array.isArray(all.blocklist)
    ? all.blocklist.map((p) => ({ pattern: String(p || "").trim(), clearCookies: false, clearStorage: false }))
    : [];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url || null;
  currentHost = currentUrl ? getHost(currentUrl) : null;

  $("displayHost").textContent = currentHost || chrome.i18n.getMessage("uiNoUrl") || "No active tab URL";
  renderRules();
  await refreshMatchChip();
  refreshHostToggleButtons();
  await updatePauseStatus();
  await refreshLastErrorChip();

  // host add/toggles
  $("addThisSite").addEventListener("click", onAddThisSite);
  $("toggleCookies").addEventListener("click", () => toggleFlagForCurrent("clearCookies"));
  $("toggleStorage").addEventListener("click", () => toggleFlagForCurrent("clearStorage"));

  // pause buttons
  $("pauseHost10").addEventListener("click", async () => {
    if (!currentHost) return;
    await sendMessage({ type: "SET_HOST_PAUSE", host: currentHost, ms: 10 * 60 * 1000 });
    mini(chrome.i18n.getMessage("uiPausedHost10", [currentHost]) || `Paused ${currentHost} for 10m`);
    await updatePauseStatus(true);
  });
  $("pauseGlobal10").addEventListener("click", async () => {
    await sendMessage({ type: "SET_GLOBAL_PAUSE", ms: 10 * 60 * 1000 });
    mini(chrome.i18n.getMessage("uiPausedGlobal10") || "Paused globally for 10m");
    await updatePauseStatus(true);
  });
  $("pauseGlobal60").addEventListener("click", async () => {
    await sendMessage({ type: "SET_GLOBAL_PAUSE", ms: 60 * 60 * 1000 });
    mini(chrome.i18n.getMessage("uiPausedGlobal60") || "Paused globally for 1h");
    await updatePauseStatus(true);
  });

  // rules panel
  $("addRule").addEventListener("click", () => {
    rules.push({ pattern: "", clearCookies: false, clearStorage: false });
    renderRules();
  });
  $("saveRules").addEventListener("click", saveRules);

  // import / export — stopPropagation so clicking these doesn't toggle the <details>
  $("importBtn").addEventListener("click", (e) => { e.stopPropagation(); $("importFile").click(); });
  $("importFile").addEventListener("change", onImportFile);
  $("exportBtn").addEventListener("click", (e) => { e.stopPropagation(); onExport(); });

  // error chip
  $("lastError").addEventListener("click", () => {
    if (!lastErrorCache) return;
    const d = new Date(lastErrorCache.time);
    alert(`[${d.toLocaleString()}] ${lastErrorCache.where}\n\n${lastErrorCache.message}`);
  });
}

function mini(text) {
  $("miniStatus").textContent = text;
}

function status(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $("status").textContent = ""; }, 3000);
}

async function refreshLastErrorChip() {
  const res = await sendMessage({ type: "GET_LAST_ERROR" });
  lastErrorCache = res?.lastError || null;
  const el = $("lastError");
  el.style.display = lastErrorCache ? "inline" : "none";
  if (lastErrorCache) el.title = chrome.i18n.getMessage("uiFooterError") || "Last error — click to view";
}

async function updatePauseStatus(refreshBadge = false) {
  const res = await sendMessage({ type: "GET_PAUSE_STATE", url: currentUrl || "" });
  if (!res?.ok) return;
  const { globalUntil, host, hostUntil, now } = res;
  const parts = [];
  if (globalUntil > now) parts.push(`Global pause until ${fmtTime(globalUntil)}`);
  if (host && hostUntil > now) parts.push(`Paused ${host} until ${fmtTime(hostUntil)} (click to clear)`);
  const el = $("pauseStatus");
  el.textContent = parts.join(" • ") || "";
  el.style.cursor = hostUntil > now ? "pointer" : "default";
  el.onclick = async () => {
    if (host && hostUntil > now) {
      await sendMessage({ type: "CLEAR_HOST_PAUSE", host });
      mini(chrome.i18n.getMessage("uiResumedHost", [host]) || `Resumed ${host}`);
      await updatePauseStatus(true);
    }
  };
  if (refreshBadge) {
    // poke the background so it updates the active tab's badge
    await sendMessage({ type: "TEST_MATCH", url: currentUrl || "" });
  }
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

async function refreshMatchChip() {
  if (!currentUrl) return chipState(chrome.i18n.getMessage("uiNoUrl") || "No active tab URL");
  const res = await sendMessage({ type: "TEST_MATCH", url: currentUrl });
  const isListed = !!rules.find(r => r.pattern === currentHost);

  if (res?.matched?.length || isListed) {
    chipState(chrome.i18n.getMessage("uiOnList") || "On the list", "ok");
    setAddRemoveButton(true);
  } else {
    chipState(chrome.i18n.getMessage("uiNotOnList") || "Not on the list");
    setAddRemoveButton(false);
  }
}

function setAddRemoveButton(listed) {
  const btn = $("addThisSite");
  if (listed) {
    btn.textContent = chrome.i18n.getMessage("uiRemoveSite") || "Remove this site";
    btn.classList.remove("primary");
    btn.classList.add("danger");
    btn.setAttribute("aria-label", chrome.i18n.getMessage("uiRemoveSite") || "Remove this site");
  } else {
    btn.textContent = chrome.i18n.getMessage("uiAddSite") || "Add this site";
    btn.classList.add("primary");
    btn.classList.remove("danger");
    btn.setAttribute("aria-label", chrome.i18n.getMessage("uiAddSite") || "Add this site");
  }
}

function chipState(text, cls = "") {
  const chip = $("matchChip");
  chip.textContent = text;
  chip.className = "chip " + cls;
}

async function onAddThisSite() {
  if (!currentHost) return;
  const idx = rules.findIndex(r => r.pattern === currentHost);
  if (idx === -1) {
    rules.unshift({ pattern: currentHost, clearCookies: false, clearStorage: false });
    await chrome.storage.sync.set({ rules });
    renderRules();
  } else {
    rules.splice(idx, 1);
    await chrome.storage.sync.set({ rules });
    renderRules();
  }
  await refreshMatchChip();
  refreshHostToggleButtons();
}

function refreshHostToggleButtons() {
  const btnCookies = $("toggleCookies");
  const btnStorage = $("toggleStorage");
  if (!currentHost) {
    btnCookies.classList.remove("active");
    btnCookies.setAttribute("aria-pressed", "false");
    btnCookies.innerHTML = `+ 🍪 <span data-i18n="uiCookies">${chrome.i18n.getMessage("uiCookies") || "Cookies"}</span>`;
    btnStorage.classList.remove("active");
    btnStorage.setAttribute("aria-pressed", "false");
    btnStorage.innerHTML = `+ 💾 <span data-i18n="uiSiteData">${chrome.i18n.getMessage("uiSiteData") || "Site data"}</span>`;
    return;
  }
  const rule = rules.find((r) => r.pattern === currentHost);
  const cookiesOn = !!rule?.clearCookies;
  const storageOn = !!rule?.clearStorage;

  btnCookies.classList.toggle("active", cookiesOn);
  btnCookies.setAttribute("aria-pressed", String(cookiesOn));
  btnCookies.textContent = cookiesOn ? `🍪 ${chrome.i18n.getMessage("uiCookies") || "Cookies"} ✓`
                                     : `+ 🍪 ${chrome.i18n.getMessage("uiCookies") || "Cookies"}`;

  btnStorage.classList.toggle("active", storageOn);
  btnStorage.setAttribute("aria-pressed", String(storageOn));
  btnStorage.textContent = storageOn ? `💾 ${chrome.i18n.getMessage("uiSiteData") || "Site data"} ✓`
                                     : `+ 💾 ${chrome.i18n.getMessage("uiSiteData") || "Site data"}`;
}

async function toggleFlagForCurrent(flagKey) {
  if (!currentHost) return;
  let idx = rules.findIndex(r => r.pattern === currentHost);
  if (idx === -1) { rules.unshift({ pattern: currentHost, clearCookies: false, clearStorage: false }); idx = 0; }
  rules[idx][flagKey] = !rules[idx][flagKey];
  await chrome.storage.sync.set({ rules });
  renderRules();
  await refreshMatchChip();
  refreshHostToggleButtons();
}

// --- rules table
function renderRules() {
  const body = $("rulesBody");
  body.innerHTML = "";
  rules.forEach((r, i) => {
    const tr = document.createElement("tr");

    const tdP = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = r.pattern || "";
    inp.placeholder = chrome.i18n.getMessage("uiPatternPlaceholder") || "host, wildcard, exact URL, or regex:^...";
    inp.addEventListener("input", () => { rules[i].pattern = inp.value; });
    tdP.appendChild(inp);

    const tdC = document.createElement("td");
    const ckC = document.createElement("input");
    ckC.type = "checkbox"; ckC.checked = !!r.clearCookies;
    ckC.setAttribute("aria-label", chrome.i18n.getMessage("uiCookies") || "Cookies");
    ckC.addEventListener("change", () => { rules[i].clearCookies = ckC.checked; });
    tdC.appendChild(ckC);

    const tdS = document.createElement("td");
    const ckS = document.createElement("input");
    ckS.type = "checkbox"; ckS.checked = !!r.clearStorage;
    ckS.setAttribute("aria-label", chrome.i18n.getMessage("uiSiteData") || "Site data");
    ckS.addEventListener("change", () => { rules[i].clearStorage = ckS.checked; });
    tdS.appendChild(ckS);

    const tdR = document.createElement("td");
    tdR.className = "right";
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = chrome.i18n.getMessage("uiRemove") || "Remove";
    btn.addEventListener("click", async () => {
      rules.splice(i, 1);
      await chrome.storage.sync.set({ rules });
      renderRules();
      await refreshMatchChip();
      refreshHostToggleButtons();
    });
    tdR.appendChild(btn);

    tr.appendChild(tdP); tr.appendChild(tdC); tr.appendChild(tdS); tr.appendChild(tdR);
    body.appendChild(tr);
  });
}

async function saveRules() {
  const clean = rules
    .map((r) => ({ pattern: (r.pattern || "").trim(), clearCookies: !!r.clearCookies, clearStorage: !!r.clearStorage }))
    .filter((r) => r.pattern.length > 0);
  rules = clean;
  await chrome.storage.sync.set({ rules });
  renderRules();
  status(chrome.i18n.getMessage("uiSaved") || "Rules saved ✓");
  await refreshMatchChip();
  refreshHostToggleButtons();
}

// --- import/export
async function onExport() {
  const res = await sendMessage({ type: "EXPORT_RULES" });
  if (!res?.ok) { status(chrome.i18n.getMessage("uiExportFailed") || "Export failed"); return; }
  const blob = new Blob([JSON.stringify(res.payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "selective-cleaner-rules.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  status(chrome.i18n.getMessage("uiExported") || "Exported ✓");
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || !Array.isArray(json.rules)) {
      status(chrome.i18n.getMessage("uiInvalidFile") || "Invalid file");
      return;
    }
    const res = await sendMessage({ type: "IMPORT_RULES", payload: json });
    if (res?.ok) {
      const all = await chrome.storage.sync.get("rules");
      rules = Array.isArray(all.rules) ? all.rules : [];
      renderRules();
      status(chrome.i18n.getMessage("uiImported") || "Imported ✓");
      await refreshMatchChip();
      refreshHostToggleButtons();
    } else {
      status(chrome.i18n.getMessage("uiImportFailed") || "Import failed");
    }
  } catch {
    status(chrome.i18n.getMessage("uiInvalidFile") || "Invalid file");
  } finally {
    e.target.value = "";
  }
}
