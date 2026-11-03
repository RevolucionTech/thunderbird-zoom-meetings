// Background: toolbar buttons, incoming reply processing and calendar-to-Zoom sync.
import * as meetings from "./lib/meetings.js";
import * as zoom from "./lib/zoom.js";

const t = (key, subs) => browser.i18n.getMessage(key.replace(/-/g, "_"), subs) || key;
const MANAGER_URL = browser.runtime.getURL("ui/manager.html");

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon.svg"),
    title,
    message,
  });
}

async function openManager(hash = "") {
  const url = MANAGER_URL + (hash ? `#${hash}` : "");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(tab => tab.url && tab.url.startsWith(MANAGER_URL));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true, url });
    if (existing.windowId) {
      await browser.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await browser.tabs.create({ url });
}

async function ownEmails() {
  const emails = new Set();
  for (const account of await messenger.accounts.list(false)) {
    for (const identity of account.identities || []) {
      if (identity.email) {
        emails.add(identity.email.toLowerCase());
      }
    }
  }
  return emails;
}

async function parseAddressList(list) {
  const result = [];
  for (const raw of list || []) {
    const parsed = await messenger.messengerUtilities.parseMailboxString(raw);
    for (const entry of parsed) {
      if (entry.email) {
        result.push({ email: entry.email.toLowerCase(), name: entry.name || "" });
      }
    }
  }
  return result;
}

async function handleMessageAction(tab) {
  const message = await messenger.messageDisplay.getDisplayedMessage(tab.id);
  if (!message) {
    return;
  }
  try {
    const applied = await meetings.processReplyMessage(message.id);
    for (const result of applied) {
      notify(t("notifyReplyTitle"), t("notifyReplyBody", [result.title || "", String(result.updates.length)]));
    }
    const linked = await meetings.meetingOfMessage(message.id);
    if (linked) {
      await openManager(`meeting=${encodeURIComponent(linked.event.calendarId)}/${encodeURIComponent(linked.event.uid)}`);
      return;
    }
  } catch (e) {
    console.error("Zoom Meetings: message inspection failed", e);
  }
  // No linked meeting: start a new one with the people of this conversation.
  const mine = await ownEmails();
  const people = await parseAddressList([message.author, ...(message.recipients || []), ...(message.ccList || [])]);
  const unique = new Map();
  for (const p of people) {
    if (!mine.has(p.email) && !unique.has(p.email)) {
      unique.set(p.email, p);
    }
  }
  const prefill = {
    title: (message.subject || "").replace(/^\s*((re|fw|fwd|aw|rv|tr)\s*:\s*)+/i, ""),
    attendees: [...unique.values()],
  };
  await openManager(`new=${encodeURIComponent(JSON.stringify(prefill))}`);
}

async function* iterateMessages(list) {
  let page = list;
  while (page) {
    for (const message of page.messages) {
      yield message;
    }
    page = page.id ? await messenger.messages.continueList(page.id) : null;
  }
}

async function handleNewMail(folder, messageList) {
  for await (const message of iterateMessages(messageList)) {
    try {
      const applied = await meetings.processReplyMessage(message.id);
      for (const result of applied) {
        const summary = result.updates.map(u => `${u.email}: ${t("partstat_" + u.partstat) || u.partstat}`).join("\n");
        notify(t("notifyReplyTitle"), `${result.title}\n${summary}`);
      }
    } catch (e) {
      console.error("Zoom Meetings: reply processing failed", e);
    }
  }
}

async function handleCalendarChange(event, changeType) {
  if (changeType === "deleted") {
    return;
  }
  try {
    const status = await zoom.status();
    if (!status.connected) {
      return;
    }
    if (await meetings.syncCalendarChangeToZoom(event)) {
      console.info(`Zoom Meetings: synced "${event.title}" to Zoom`);
    }
  } catch (e) {
    console.error("Zoom Meetings: calendar to Zoom sync failed", e);
    notify(t("notifySyncErrorTitle"), `${event.title}: ${e.message}`);
  }
}

// Zoom's REST API answers "403 Invalid CORS request" to any request carrying a
// browser Origin header, and Thunderbird adds moz-extension:// to our POST/PATCH/DELETE
// calls. Strip it: the extension already holds host permissions for these URLs.
browser.webRequest.onBeforeSendHeaders.addListener(
  details => ({
    requestHeaders: details.requestHeaders.filter(h => h.name.toLowerCase() !== "origin"),
  }),
  { urls: ["https://api.zoom.us/*", "https://zoom.us/oauth/token*"] },
  ["blocking", "requestHeaders"]
);

browser.browserAction.onClicked.addListener(() => openManager());
browser.messageDisplayAction.onClicked.addListener(tab => handleMessageAction(tab));
messenger.messages.onNewMailReceived.addListener(handleNewMail);
messenger.zoomCalendar.onEventChanged.addListener(handleCalendarChange);

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    const config = await zoom.getConfig();
    if (!config.clientId) {
      browser.runtime.openOptionsPage();
    }
  }
});
