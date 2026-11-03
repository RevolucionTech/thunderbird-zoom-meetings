import * as zoom from "../lib/zoom.js";

const t = (key, subs) => browser.i18n.getMessage(key.replace(/-/g, "_"), subs) || key;
const $ = id => document.getElementById(id);

function banner(message, kind = "error") {
  const node = $("banner");
  node.textContent = message;
  node.className = `banner ${kind}`;
  node.hidden = false;
}

async function renderStatus() {
  const status = await zoom.status();
  const box = $("status");
  box.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `dot ${status.connected ? "ok" : "bad"}`;
  const text = document.createElement("span");
  text.textContent = status.connected
    ? t("zoomConnectedAs", [status.user ? `${status.user.name} <${status.user.email}>`.trim() : "OK"])
    : t("zoomNotConnected");
  box.append(dot, text);
  $("btnDisconnect").hidden = !status.connected;
}

async function renderCalendars() {
  const list = $("calendars");
  list.replaceChildren();
  for (const c of await messenger.zoomCalendar.listCalendars()) {
    if (c.disabled) continue;
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${c.name} (${c.type})`;
    const pill = document.createElement("span");
    pill.className = `pill ${c.canSchedule ? "ok" : "bad"}`;
    pill.textContent = c.canSchedule ? c.identityEmail : c.readOnly ? t("calendarReadOnly") : t("calendarNoIdentity");
    li.append(name, pill);
    list.append(li);
  }
}

async function init() {
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  $("redirectUrl").textContent = zoom.getRedirectUrl();
  const config = await zoom.getConfig();
  $("clientId").value = config.clientId || "";
  $("clientSecret").value = config.clientSecret || "";

  $("btnCopyRedirect").addEventListener("click", async () => {
    await navigator.clipboard.writeText(zoom.getRedirectUrl());
    banner(t("copied"), "ok");
  });
  $("btnSave").addEventListener("click", async () => {
    await zoom.saveConfig({ clientId: $("clientId").value.trim(), clientSecret: $("clientSecret").value.trim() });
    banner(t("optionsSaved"), "ok");
  });
  $("btnConnect").addEventListener("click", async () => {
    $("btnConnect").disabled = true;
    try {
      await zoom.saveConfig({ clientId: $("clientId").value.trim(), clientSecret: $("clientSecret").value.trim() });
      const user = await zoom.connect();
      banner(t("zoomConnectedAs", [user?.email || "OK"]), "ok");
    } catch (e) {
      banner(e.message || String(e));
    } finally {
      $("btnConnect").disabled = false;
      renderStatus();
    }
  });
  $("btnDisconnect").addEventListener("click", async () => {
    await zoom.disconnect();
    renderStatus();
  });
  await renderStatus();
  await renderCalendars();
}

init().catch(e => banner(e.message || String(e)));
