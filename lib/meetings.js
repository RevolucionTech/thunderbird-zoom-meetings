// Meeting orchestration: keeps Zoom and the native Thunderbird calendar in step.
import * as zoom from "./zoom.js";
import { toRRule, toZoomRecurrence, fromRRule, validate } from "./recurrence.js";
import { eventFieldsFromZoom, zoomListToEvents } from "./zoomEvents.js";

const t = (key, subs) => browser.i18n.getMessage(key.replace(/-/g, "_"), subs) || key;
const ZOOM_BLOCK_SEPARATOR = "--- Zoom ---";

export class MeetingError extends Error {
  constructor(key, subs = []) {
    super(t(key, subs));
    this.key = key;
  }
}

function formatZoomId(id) {
  const s = String(id);
  return s.length === 11 ? `${s.slice(0, 3)} ${s.slice(3, 7)} ${s.slice(7)}` : s.replace(/(\d{3})(?=\d)/g, "$1 ");
}

export function zoomBlock(zoomMeeting) {
  const lines = [ZOOM_BLOCK_SEPARATOR, `${t("inviteJoin")}: ${zoomMeeting.join_url}`, `${t("inviteMeetingId")}: ${formatZoomId(zoomMeeting.id)}`];
  if (zoomMeeting.password) {
    lines.push(`${t("invitePasscode")}: ${zoomMeeting.password}`);
  }
  return lines.join("\n");
}

export function notesOf(description) {
  const index = (description || "").indexOf(ZOOM_BLOCK_SEPARATOR);
  return (index >= 0 ? description.slice(0, index) : description || "").trim();
}

function composeDescription(notes, zoomMeeting) {
  return [notes && notes.trim(), zoomBlock(zoomMeeting)].filter(Boolean).join("\n\n");
}

function fingerprint(event) {
  return [event.title, event.startLocal, event.durationMin, event.tzid, event.rrule || ""].join("|");
}

export async function saveFingerprint(event) {
  if (!event.zoomId) {
    return;
  }
  const { fingerprints = {} } = await browser.storage.local.get("fingerprints");
  fingerprints[event.zoomId] = fingerprint(event);
  await browser.storage.local.set({ fingerprints });
}

function checkForm(form) {
  if (!form.title || !form.title.trim()) {
    throw new MeetingError("errorTitleRequired");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.startLocal || "")) {
    throw new MeetingError("errorStartRequired");
  }
  if (!(form.durationMin > 0)) {
    throw new MeetingError("errorDuration");
  }
  const recurrenceError = validate(form.recurrence);
  if (recurrenceError) {
    throw new MeetingError(recurrenceError.key, recurrenceError.subs);
  }
}

function zoomModel(form) {
  return {
    title: form.title.trim(),
    agenda: form.notes || "",
    startLocal: form.startLocal,
    durationMin: form.durationMin,
    tzid: form.tzid,
    settings: form.settings || {},
  };
}

/**
 * form: { calendarId, title, notes, startLocal, durationMin, tzid,
 *         attendees: [{email, name}], recurrence, settings, sendInvitations }
 */
export async function createMeeting(form) {
  checkForm(form);
  const zoomRecurrence = toZoomRecurrence(form.recurrence, form.startLocal);
  const zm = await zoom.createMeeting(zoomModel(form), zoomRecurrence);
  try {
    const event = await messenger.zoomCalendar.createEvent(
      form.calendarId,
      {
        title: form.title.trim(),
        description: composeDescription(form.notes, zm),
        location: zm.join_url,
        startLocal: form.startLocal,
        durationMin: form.durationMin,
        tzid: form.tzid,
        attendees: form.attendees,
        rrule: toRRule(form.recurrence, form.startLocal),
        zoom: { id: String(zm.id), joinUrl: zm.join_url, password: zm.password || "" },
      },
      !!form.sendInvitations && form.attendees.length > 0
    );
    await saveFingerprint(event);
    return event;
  } catch (e) {
    // Do not leave an orphan Zoom meeting when the calendar write fails.
    await zoom.deleteMeeting(zm.id).catch(() => {});
    throw e;
  }
}

export async function updateMeeting(event, form, sendUpdates) {
  checkForm(form);
  const zoomRecurrence = toZoomRecurrence(form.recurrence, form.startLocal);
  await zoom.updateMeeting(event.zoomId, zoomModel(form), zoomRecurrence);
  const zm = { id: event.zoomId, join_url: event.zoomJoinUrl, password: event.zoomPassword };
  const updated = await messenger.zoomCalendar.updateEvent(
    event.calendarId,
    event.uid,
    {
      title: form.title.trim(),
      description: composeDescription(form.notes, zm),
      startLocal: form.startLocal,
      durationMin: form.durationMin,
      tzid: form.tzid,
      attendees: form.attendees,
      rrule: toRRule(form.recurrence, form.startLocal),
    },
    !!sendUpdates
  );
  await saveFingerprint(updated);
  return updated;
}

export async function cancelMeeting(event, notify) {
  if (event.zoomId) {
    await zoom.deleteMeeting(event.zoomId);
  }
  await messenger.zoomCalendar.cancelEvent(event.calendarId, event.uid, !!notify);
}

/** Adds a Zoom meeting to an existing native calendar event. */
export async function addZoomToEvent(event, sendUpdates) {
  const form = formFromEvent(event);
  checkForm(form);
  const zm = await zoom.createMeeting(zoomModel(form), toZoomRecurrence(form.recurrence, form.startLocal));
  const updated = await messenger.zoomCalendar.updateEvent(
    event.calendarId,
    event.uid,
    {
      description: composeDescription(event.description, zm),
      location: zm.join_url,
      zoom: { id: String(zm.id), joinUrl: zm.join_url, password: zm.password || "" },
    },
    !!sendUpdates && event.attendees.length > 0
  );
  await saveFingerprint(updated);
  return updated;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Every meeting of the Zoom account, as events without a calendar. */
export async function listZoomMeetings() {
  return zoomListToEvents(await zoom.listMeetings(), Date.now(), localTimezone());
}

/** Completes a listed Zoom meeting with the fields only its detail provides. */
export async function zoomMeetingDetail(event) {
  const zm = await zoom.getMeeting(event.zoomId);
  return {
    ...event,
    ...eventFieldsFromZoom(zm, localTimezone()),
    description: composeDescription(zm.agenda, zm),
    zoomPassword: zm.password || null,
  };
}

/** Creates the calendar event of a meeting that already exists in Zoom. Nothing is sent. */
export async function addZoomMeetingToCalendar(zoomId, calendarId) {
  const zm = await zoom.getMeeting(zoomId);
  const fields = eventFieldsFromZoom(zm, localTimezone());
  if (!fields) {
    throw new MeetingError("noFixedTimeHelp");
  }
  const event = await messenger.zoomCalendar.createEvent(
    calendarId,
    {
      ...fields,
      title: zm.topic || "",
      description: composeDescription(zm.agenda, zm),
      location: zm.join_url,
      attendees: [],
      zoom: { id: String(zm.id), joinUrl: zm.join_url, password: zm.password || "" },
    },
    false
  );
  await saveFingerprint(event);
  return event;
}

export function formFromEvent(event) {
  return {
    calendarId: event.calendarId,
    title: event.title,
    notes: notesOf(event.description),
    startLocal: event.startLocal,
    durationMin: event.durationMin,
    tzid: event.tzid || localTimezone(),
    attendees: event.attendees.map(a => ({ email: a.email, name: a.name })),
    recurrence: fromRRule(event.rrule),
    settings: {},
  };
}

/** Pushes changes made with Thunderbird's own event dialog to Zoom. */
export async function syncCalendarChangeToZoom(event) {
  if (!event.zoomId || !event.startLocal) {
    return false;
  }
  const { fingerprints = {} } = await browser.storage.local.get("fingerprints");
  const current = fingerprint(event);
  if (fingerprints[event.zoomId] === current) {
    return false;
  }
  const form = formFromEvent(event);
  if (validate(form.recurrence)) {
    return false;
  }
  await zoom.updateMeeting(event.zoomId, zoomModel(form), toZoomRecurrence(form.recurrence, form.startLocal));
  fingerprints[event.zoomId] = current;
  await browser.storage.local.set({ fingerprints });
  return true;
}

export async function startMeeting(event) {
  const zm = await zoom.getMeeting(event.zoomId);
  await messenger.windows.openDefaultBrowser(zm.start_url);
}

export async function joinMeeting(event) {
  await messenger.windows.openDefaultBrowser(event.zoomJoinUrl);
}

export function stats(event) {
  const result = { accepted: 0, declined: 0, tentative: 0, pending: 0, total: event.attendees.length };
  for (const a of event.attendees) {
    if (a.partstat === "ACCEPTED") result.accepted++;
    else if (a.partstat === "DECLINED") result.declined++;
    else if (a.partstat === "TENTATIVE") result.tentative++;
    else result.pending++;
  }
  return result;
}

// ---- Mail integration ----------------------------------------------------

function collectCalendarParts(part, out) {
  const type = (part.contentType || "").toLowerCase();
  if ((type === "text/calendar" || type === "application/ics") && part.body) {
    out.push(part.body);
  }
  for (const child of part.parts || []) {
    collectCalendarParts(child, out);
  }
}

export async function calendarTextsOfMessage(messageId) {
  const texts = [];
  const full = await messenger.messages.getFull(messageId, { decodeContent: true });
  collectCalendarParts(full, texts);
  if (!texts.length) {
    const attachments = await messenger.messages.listAttachments(messageId);
    for (const att of attachments) {
      const type = (att.contentType || "").toLowerCase();
      if (type === "text/calendar" || type === "application/ics" || /\.ics$/i.test(att.name || "")) {
        const file = await messenger.messages.getAttachmentFile(messageId, att.partName);
        texts.push(await file.text());
      }
    }
  }
  return texts;
}

/** Applies iTIP REPLY messages to Zoom meetings. Returns applied results. */
export async function processReplyMessage(messageId) {
  const applied = [];
  for (const text of await calendarTextsOfMessage(messageId)) {
    const info = await messenger.zoomCalendar.parseIcs(text);
    if (info.method !== "REPLY") {
      continue;
    }
    const known = await Promise.all(info.uids.map(uid => messenger.zoomCalendar.findEventByUid(uid)));
    if (!known.some(e => e && e.zoomId)) {
      continue;
    }
    const result = await messenger.zoomCalendar.applyItipReply(text);
    if (result.matched && result.updates.length) {
      applied.push(result);
    }
  }
  return applied;
}

/** Finds the Zoom meeting a message refers to, if any. */
export async function meetingOfMessage(messageId) {
  for (const text of await calendarTextsOfMessage(messageId)) {
    const info = await messenger.zoomCalendar.parseIcs(text);
    for (const uid of info.uids) {
      const event = await messenger.zoomCalendar.findEventByUid(uid);
      if (event) {
        return { event, method: info.method };
      }
    }
  }
  return null;
}
