import { PLATFORMS, originsFor, platformForUrl, platformById } from "../platforms/index.js";
import { normalizeSettings } from "./settings.js";

const popupUrl = chrome.runtime.getURL("popup/popup.html");
void (async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch {}
})();
const cssFile = "interventions/grayscale.css";
const scriptFile = "content/controller.js";
const accessReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let queue = Promise.resolve();
const serial = async task => {
  const previous = queue;
  let release;
  queue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { release(); }
};
async function readSettings() {
  await accessReady;
  return normalizeSettings((await chrome.storage.local.get("settings")).settings);
}
async function granted(platform) {
  return chrome.permissions.contains({ origins: originsFor(platform) });
}
async function eligibility(sender) {
  const platform = platformForUrl(sender.url);
  if (!platform || !sender.tab || sender.frameId !== 0) return { enabled: false };
  const settings = await readSettings();
  return {
    enabled: settings.platforms[platform.id].enabled && await granted(platform),
    platformId: platform.id
  };
}
function configMessage(settings) {
  return { type: "MEH_CONFIG", enabledIds: PLATFORMS.filter(p => settings.platforms[p.id].enabled).map(p => p.id) };
}
async function reconcile() {
  const settings = await readSettings();
  let changed = false;
  for (const platform of PLATFORMS) {
    if (settings.platforms[platform.id].enabled && !await granted(platform)) {
      settings.platforms[platform.id].enabled = false;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ settings });
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const activeIds = new Set(PLATFORMS.filter(p => settings.platforms[p.id].enabled).map(p => "meh-" + p.id));
  const removeIds = registered.filter(s => s.id.startsWith("meh-") && !activeIds.has(s.id)).map(s => s.id);
  if (removeIds.length) await chrome.scripting.unregisterContentScripts({ ids: removeIds });
  for (const platform of PLATFORMS.filter(p => settings.platforms[p.id].enabled)) {
    if (!registered.some(s => s.id === "meh-" + platform.id)) {
      await chrome.scripting.registerContentScripts([{
        id: "meh-" + platform.id, matches: originsFor(platform),
        js: [scriptFile], css: [cssFile], runAt: "document_start",
        allFrames: false, persistAcrossSessions: true, world: "ISOLATED"
      }]);
    }
  }

  // Tab IDs allow already-injected controllers to clean up after external revocation.
  // Never retain URLs, titles or tab inventory. Unsupported tabs have no receiver.
  const tabs = await chrome.tabs.query({});
  const message = configMessage(settings);
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })));

  let needsReload = false;
  for (const platform of PLATFORMS.filter(p => settings.platforms[p.id].enabled)) {
    const matching = await chrome.tabs.query({ url: originsFor(platform) });
    for (const tab of matching) {
      try {
        let status;
        try { status = await chrome.tabs.sendMessage(tab.id, { type: "MEH_STATUS" }, { frameId: 0 }); } catch {}
        if (!status) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [0] }, files: [cssFile] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: [scriptFile] });
        }
        await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
      } catch { needsReload = true; }
    }
  }
  return { settings, needsReload };
}
async function setPlatform(id, enabled) {
  const platform = platformById(id);
  if (!platform || enabled !== true) throw new Error("To turn MEH off, answer the question on the current site. This only pauses the current visit.");
  if (enabled && !await granted(platform)) throw new Error("Website access was not granted. Try enabling it again.");
  const settings = await readSettings();
  settings.platforms[id].enabled = enabled;
  await chrome.storage.local.set({ settings });
  const outcome = await reconcile();
  return { ok: true, needsReload: outcome.needsReload };
}
async function model(windowId) {
  const { settings, needsReload } = await reconcile();
  const [tab] = await chrome.tabs.query({ active: true, ...(Number.isInteger(windowId) ? { windowId } : { currentWindow: true }) });
  const platform = platformForUrl(tab?.url);
  return {
    ok: true, settings, needsReload, activeTabId: tab?.id ?? null,
    current: platform ? { tabId: tab.id, platformId: platform.id, label: platform.label } : null
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return;
  if (message.type === "MEH_ELIGIBILITY" && sender.tab) {
    void (async () => {
      try { respond(await eligibility(sender)); }
      catch { respond({ enabled: false }); }
    })();
    return true;
  }
  if (sender.url !== popupUrl || sender.tab) return;
  let operation;
  if (message.type === "MEH_MODEL") operation = () => model(message.windowId);
  else if (message.type === "MEH_SET") operation = () => setPlatform(message.id, message.enabled);
  else if (message.type === "MEH_RESET") operation = () => { throw new Error("Manage extension access in Chrome settings."); };
  else return;
  void (async () => {
    try { respond(await serial(operation)); }
    catch (error) { respond({ ok: false, error: error.message || "Change could not be saved. Try again." }); }
  })();
  return true;
});
const recover = () => {
  void (async () => {
    try { await serial(reconcile); } catch {}
  })();
};
chrome.runtime.onInstalled.addListener(recover);
chrome.runtime.onStartup.addListener(recover);
chrome.permissions.onAdded.addListener(recover);
chrome.permissions.onRemoved.addListener(recover);
