(() => {
  if (globalThis.__mehModeController) return;
  globalThis.__mehModeController = true;
  const marker = "data-meh-mode-grayscale";
  let enabled = false;
  let visitOff = false;
  let platformId = null;
  let port = null;
  let preview = null;
  let lastToken = 0;
  let stateRevision = 0;
  const documentToken = crypto.randomUUID();

  const render = () => {
    if (!document.documentElement) return;
    if (enabled && !visitOff && !preview) document.documentElement.setAttribute(marker, "on");
    else document.documentElement.removeAttribute(marker);
  };
  const send = message => {
    try { port?.postMessage(message); } catch { cancel(); }
  };
  function cancel() {
    preview = null;
    render();
  }
  function detach() {
    const previous = port;
    port = null;
    cancel();
    try { previous?.disconnect(); } catch {}
  }
  function configure(value) {
    stateRevision++;
    enabled = value === true;
    if (!enabled) {
      visitOff = false;
      send({ type: "STOP" });
      detach();
    }
    render();
    if (enabled) send({ type: "READY", enabled, visitOff, documentToken });
  }
  async function refresh() {
    const revision = ++stateRevision;
    try {
      const result = await chrome.runtime.sendMessage({ type: "MEH_ELIGIBILITY" });
      if (revision !== stateRevision) return;
      platformId = result?.platformId || null;
      configure(result?.enabled);
    } catch {
      if (revision === stateRevision) configure(false);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "MEH_CONFIG") {
      if (platformId) configure(message.enabledIds?.includes(platformId) === true);
      else void refresh();
      reply({ ok: true });
    }
    if (message?.type === "MEH_STATUS") {
      reply({ enabled, visitOff, documentToken, platformId });
    }
  });
  chrome.runtime.onConnect.addListener(incoming => {
    if (incoming.name !== "meh-preview" ||
        incoming.sender?.id !== chrome.runtime.id ||
        incoming.sender?.url !== chrome.runtime.getURL("popup/popup.html") ||
        incoming.sender?.tab) {
      incoming.disconnect(); return;
    }
    detach();
    port = incoming;
    lastToken = 0;
    incoming.onMessage.addListener(message => {
      if (port !== incoming) return;
      if (["PAUSE_VISIT", "RESUME_VISIT"].includes(message?.type)) {
        if (!enabled || document.hidden || message.documentToken !== documentToken) return;
        visitOff = message.type === "PAUSE_VISIT";
        cancel();
        send({ type: "READY", enabled, visitOff, documentToken });
        return;
      }
      if (message?.type === "END" && Number.isSafeInteger(message.token)) {
        lastToken = Math.max(lastToken, message.token);
        if (preview === message.token) cancel();
        return;
      }
      if (message?.type !== "BEGIN" || !enabled || visitOff || document.hidden ||
          message.documentToken !== documentToken ||
          !Number.isSafeInteger(message.token) || message.token <= lastToken) return;
      lastToken = message.token;
      preview = message.token;
      render();
      send({ type: "PEEKING", token: preview });
    });
    incoming.onDisconnect.addListener(() => {
      if (port === incoming) { port = null; cancel(); }
    });
    incoming.postMessage({ type: "READY", enabled, visitOff, documentToken });
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) detach(); });
  window.addEventListener("pagehide", () => { visitOff = false; detach(); });
  window.addEventListener("pageshow", () => { visitOff = false; cancel(); void refresh(); });
  // Cancel any active hold when the page enters a frozen state.
  document.addEventListener("freeze", detach);
  document.addEventListener("resume", () => { cancel(); void refresh(); });
  document.addEventListener("DOMContentLoaded", render, { once: true });
  void refresh();
})();
