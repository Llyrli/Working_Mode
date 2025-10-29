// content.js — in-page interactive modal for rest alarm + toast/notification fallback
(function(){
  if (window.top !== window.self) return;

  function showToast(msg) {
    const id = "__working_mode_toast__";
    let wrap = document.getElementById(id);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = id;
      wrap.style.position = "fixed";
      wrap.style.top = "16px";
      wrap.style.right = "16px";
      wrap.style.zIndex = "2147483647";
      document.documentElement.appendChild(wrap);
    }
    const card = document.createElement("div");
    card.textContent = msg;
    card.style.background = "rgba(17,24,39,0.92)";
    card.style.color = "#fff";
    card.style.padding = "10px 12px";
    card.style.marginTop = "8px";
    card.style.borderRadius = "10px";
    card.style.boxShadow = "0 6px 18px rgba(0,0,0,.25)";
    card.style.fontSize = "13px";
    wrap.appendChild(card);
    setTimeout(()=> card.remove(), 5000);
  }

  async function showPageNotification(message) {
    try {
      if (!("Notification" in window)) { showToast(message); return; }
      let perm = Notification.permission;
      if (perm === "default") perm = await Notification.requestPermission();
      if (perm === "granted") {
        const icon = chrome.runtime.getURL("icons/icon-128.png");
        new Notification("Rest Alarm", { body: message, icon });
      } else { showToast(message); }
    } catch { showToast(message); }
  }

  let modalOpen = false;
  function createModal({ minutesOnRest = 0, thresholdMinutes = 5 } = {}) {
    if (modalOpen) return;
    modalOpen = true;

    const overlay = document.createElement("div");
    overlay.id = "__working_mode_modal__";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.zIndex = "2147483647";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const card = document.createElement("div");
    card.style.width = "min(420px, 92vw)";
    card.style.background = "#ffffff";
    card.style.borderRadius = "14px";
    card.style.boxShadow = "0 24px 48px rgba(0,0,0,0.25)";
    card.style.padding = "16px";
    card.style.color = "#111827";
    card.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";

    const title = document.createElement("div");
    title.textContent = "Rest Alarm";
    title.style.fontWeight = "800";
    title.style.fontSize = "16px";
    title.style.marginBottom = "8px";

    const msg = document.createElement("div");
    msg.style.fontSize = "13px";
    msg.style.lineHeight = "1.5";
    msg.style.marginBottom = "12px";
    msg.textContent = `You have been on the rest page for ${minutesOnRest} minutes (threshold: ${thresholdMinutes} minutes).`;

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.justifyContent = "flex-end";

    function mkBtn(text) {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.padding = "6px 10px";
      b.style.borderRadius = "8px";
      b.style.border = "1px solid #d1d5db";
      b.style.background = "#fff";
      b.style.cursor = "pointer";
      b.style.fontSize = "13px";
      b.onmouseenter = () => (b.style.background = "#f9fafb");
      b.onmouseleave = () => (b.style.background = "#fff");
      return b;
    }

    const closeOnce = mkBtn("Close this reminder");
    const snooze30  = mkBtn("30 minutes no reminder");
    const disable   = mkBtn("Disable Rest Alarm");

    closeOnce.onclick = () => resolveAction("closeOnce");
    snooze30.onclick  = () => resolveAction("snooze30");
    disable.onclick   = () => resolveAction("disable");

    btnRow.appendChild(closeOnce);
    btnRow.appendChild(snooze30);
    btnRow.appendChild(disable);

    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);

    function cleanup() { overlay.remove(); modalOpen = false; }
    function resolveAction(action) {
      chrome.runtime.sendMessage({ type: "REST_MODAL_ACTION", action }, () => { void chrome.runtime.lastError; });
      cleanup();
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { closeOnce.click(); } });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SHOW_REST_TOAST") {
      const text = msg?.payload?.message || "Rest alarm threshold reached";
      showPageNotification(text);
    }
    if (msg?.type === "SHOW_REST_MODAL") {
      createModal(msg?.payload || {});
    }
  });
})();
