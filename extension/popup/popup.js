import { PLATFORMS, originsFor } from "../platforms/index.js";
import { Hold } from "./hold.js";

const $ = id => document.getElementById(id);
const peek = $("peek");
const panelWindow = await chrome.windows.getCurrent();
let model = null;
let activeTabId = null;
let port = null;
let documentToken = null;
let connectionVersion = 0;
let ready = false;
let visitOff = false;
let busy = false;
let refreshVersion = 0;
let refreshing = false;
const rows = new Map();

const error = message => { $("error").textContent = message || ""; $("error").hidden = !message; };
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "Could not connect. Close and reopen MEH MODE.");
  return result;
}
function send(message) {
  try { port?.postMessage(message); } catch { disconnect(); }
}
const hold = new Hold({
  begin: token => send({ type: "BEGIN", token, documentToken }),
  end: token => send({ type: "END", token }),
  change: active => {
    peek.classList.toggle("is-held", active);
    $("current-status").textContent = active ? "Showing color..." : statusText();
  }
});
function statusText() {
  if (!model?.current) return "Not active on this page.";
  if (!model.settings.platforms[model.current.platformId].enabled) return "Off for this site.";
  if (ready && visitOff) return "Off for this visit. Reload to return to grayscale.";
  return ready ? model.current.label + " is appropriately meh." : "Reload this page to connect MEH MODE.";
}
function disconnect() {
  hold.stop();
  const old = port;
  port = null;
  ready = false;
  documentToken = null;
  connectionVersion++;
  peek.disabled = true;
  updateControls();
  try { old?.disconnect(); } catch {}
}
function connect() {
  disconnect();
  if (!model?.current || !model.settings.platforms[model.current.platformId].enabled) {
    $("current-status").textContent = statusText(); return;
  }
  const version = connectionVersion;
  const incoming = chrome.tabs.connect(model.current.tabId, { name: "meh-preview", frameId: 0 });
  port = incoming;
  $("current-status").textContent = "Connecting to this page...";
  incoming.onMessage.addListener(message => {
    if (port !== incoming || version !== connectionVersion) return;
    if (message?.type === "READY") {
      ready = message.enabled === true;
      visitOff = message.visitOff === true;
      documentToken = message.documentToken;
      updateControls();
      if (visitOff) closeQuestion();
      if (!hold.active) $("current-status").textContent = statusText();
    } else if (message?.type === "PEEKING" && hold.active?.token === message.token) {
      $("current-status").textContent = "Peeking in color. Keep holding.";
    } else if (message?.type === "STOP") {
      disconnect();
      $("current-status").textContent = "MEH MODE changed. Reopen to check this page.";
    }
  });
  incoming.onDisconnect.addListener(() => {
    // Reading lastError prevents an expected absent-controller warning.
    void chrome.runtime.lastError;
    if (port !== incoming) return;
    disconnect();
    $("current-status").textContent = "Reload this page to reconnect MEH MODE.";
  });
}
async function refresh() {
  const version = ++refreshVersion;
  refreshing = true;
  disconnect();
  $("current-status").textContent = "Checking this page...";
  try {
    const next = await request({ type: "MEH_MODEL", windowId: panelWindow.id });
    if (version !== refreshVersion) return;
    model = next;
    activeTabId = next.activeTabId;
    refreshing = false;
    let count = 0;
    for (const platform of PLATFORMS) {
      const on = model.settings.platforms[platform.id].enabled;
      const row = rows.get(platform.id);
      row.input.checked = on;
      row.state.textContent = on ? "On" : "Off";
      if (on) count++;
    }
    $("site-summary").textContent = count ? count + (count === 1 ? " site selected" : " sites selected") : "All off";
    $("first-run").hidden = count > 0;
    if (next.needsReload) error("Some open pages need a reload to apply MEH MODE.");
    connect();
  } catch (cause) {
    if (version !== refreshVersion) return;
    refreshing = false;
    disconnect(); error(cause.message);
  }
}
function setBusy(value) {
  busy = value;
  updateControls();
}
function updateControls() {
  for (const [id, row] of rows) {
    const enrolled = model?.settings.platforms[id].enabled === true;
    const current = model?.current?.platformId === id;
    row.input.checked = enrolled && !(current && ready && visitOff);
    row.state.textContent = row.input.checked ? "On" : "Off";
    row.input.disabled = busy || refreshing || (enrolled && (!current || !ready));
    row.input.title = enrolled && !current ? "Open this site to turn MEH off for a visit." : "";
  }
  peek.disabled = busy || !ready || visitOff;
  $("confirm-pause").disabled = busy || refreshing || !ready || !$("reason").value.trim();
}
function closeQuestion() {
  $("pause-form").hidden = true;
  $("reason").value = "";
  updateControls();
}
for (const platform of PLATFORMS) {
  const label = document.createElement("label");
  label.className = "site-row";
  const name = document.createElement("span");
  name.className = "name"; name.textContent = platform.label;
  const control = document.createElement("span"); control.className = "site-control";
  const state = document.createElement("span"); state.className = "site-state"; state.textContent = "Off"; state.setAttribute("aria-hidden", "true");
  const input = document.createElement("input");
  input.type = "checkbox"; input.id = "site-" + platform.id; input.setAttribute("role", "switch");
  const decoration = document.createElement("span"); decoration.className = "switch"; decoration.setAttribute("aria-hidden", "true");
  control.append(state, input, decoration); label.append(name, control);
  $("site-list").append(label); rows.set(platform.id, { input, state });
  input.addEventListener("change", async () => {
    const enabled = input.checked;
    if (model?.settings.platforms[platform.id].enabled) {
      hold.stop(); error("");
      if (!ready || model.current?.platformId !== platform.id) { updateControls(); return; }
      if (enabled && visitOff) send({ type: "RESUME_VISIT", documentToken });
      else {
        $("pause-form").hidden = false;
        $("reason").focus();
        $("pause-form").scrollIntoView({ block: "nearest" });
      }
      updateControls();
      return;
    }
    // Must be invoked synchronously inside this user gesture, before any await.
    const permission = enabled ? chrome.permissions.request({ origins: originsFor(platform) }) : Promise.resolve(true);
    hold.stop(); setBusy(true); error("");
    try {
      if (!await permission) throw new Error("Website access was not granted. This site stays off.");
      const result = await request({ type: "MEH_SET", id: platform.id, enabled });
      if (result.needsReload) error("Reload this page to finish applying your change.");
    } catch (cause) { error(cause.message); }
    finally { await refresh(); setBusy(false); }
  });
}
peek.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !event.isPrimary || !ready || visitOff || busy) return;
  event.preventDefault();
  peek.focus();
  peek.setPointerCapture(event.pointerId);
  hold.start("pointer:" + event.pointerId);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  window.addEventListener(type, event => hold.stop("pointer:" + event.pointerId), true);
}
peek.addEventListener("keydown", event => {
  if (![" ", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (!event.repeat && ready && !visitOff && !busy) hold.start("key:" + event.key);
});
window.addEventListener("keyup", event => hold.stop("key:" + event.key), true);
window.addEventListener("keydown", event => { if (event.key === "Escape") hold.stop(); }, true);
peek.addEventListener("contextmenu", event => event.preventDefault());
peek.addEventListener("dragstart", event => event.preventDefault());
peek.addEventListener("blur", () => hold.stop());
window.addEventListener("blur", () => hold.stop());
window.addEventListener("pagehide", disconnect);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnect();
  else if (!busy) void refresh();
});
function changeContext() {
  refreshVersion++;
  disconnect();
  model = null;
  visitOff = false;
  closeQuestion();
  error("");
  void refresh();
}
chrome.tabs.onActivated.addListener(info => {
  if (info.windowId === panelWindow.id) { activeTabId = info.tabId; changeContext(); }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== activeTabId) return;
  if (change.status === "loading" || change.url) changeContext();
  else if (change.status === "complete") void refresh();
});
$("about-toggle").addEventListener("click", () => {
  hold.stop();
  $("about").hidden = !$("about").hidden;
  $("about-toggle").setAttribute("aria-expanded", String(!$("about").hidden));
});
$("reason").addEventListener("input", updateControls);
$("cancel-pause").addEventListener("click", () => { closeQuestion(); rows.get(model.current.platformId).input.focus(); });
$("pause-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!ready || busy || !$("reason").value.trim()) return;
  hold.stop();
  send({ type: "PAUSE_VISIT", documentToken });
  $("reason").value = "";
  updateControls();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings && !busy) void refresh();
});
void refresh();
if (chrome.sidePanel.getLayout) {
  void (async () => {
    try {
      const layout = await chrome.sidePanel.getLayout();
      $("panel-position").hidden = layout.side !== "left";
    } catch {}
  })();
}
