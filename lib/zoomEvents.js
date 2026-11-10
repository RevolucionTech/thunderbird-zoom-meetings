// Pure conversions from Zoom API meetings to the event shape used by the manager.
import { fromZoomRecurrence, toRRule } from "./recurrence.js";

const RECURRING_NO_FIXED_TIME = 3;
const RECURRING_FIXED_TIME = 8;
const DEFAULT_DURATION_MIN = 60;
// Zoom limits the agenda to 2000 characters.
const AGENDA_MAX_LENGTH = 2000;
// Fixed English marker, so that any UI language can read the list back.
const INVITEES_MARKER = "--- Invitees ---";

function inviteeLine({ email, name }) {
  const clean = (name || "").replace(/[<>\r\n]/g, "").trim();
  return clean ? `${clean} <${email}>` : email;
}

/**
 * Zoom agenda made of the user's notes plus the invitee list, which is the
 * only place where Zoom can keep it for other computers. Invitees take
 * precedence over notes when the agenda limit is reached.
 */
export function composeAgenda(notes, attendees) {
  const cleanNotes = (notes || "").trim();
  if (!attendees || !attendees.length) {
    return cleanNotes.slice(0, AGENDA_MAX_LENGTH);
  }
  let block = INVITEES_MARKER;
  for (const attendee of attendees) {
    const line = `\n${inviteeLine(attendee)}`;
    if (block.length + line.length > AGENDA_MAX_LENGTH) break;
    block += line;
  }
  const room = AGENDA_MAX_LENGTH - block.length - 2;
  const keptNotes = room > 0 ? cleanNotes.slice(0, room).trim() : "";
  return keptNotes ? `${keptNotes}\n\n${block}` : block;
}

/** Splits a Zoom agenda into the user's notes and the invitee list. */
export function splitAgenda(agenda) {
  const text = (agenda || "").replace(/\r\n/g, "\n");
  const index = text.indexOf(INVITEES_MARKER);
  if (index < 0) {
    return { notes: text.trim(), invitees: [] };
  }
  const invitees = [];
  const seen = new Set();
  for (const raw of text.slice(index + INVITEES_MARKER.length).split("\n")) {
    const line = raw.trim();
    const match = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(line) || /^()([^<>\s]+@[^<>\s]+)$/.exec(line);
    if (!match) continue;
    const email = match[2].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    invitees.push({ email, name: match[1].trim() });
  }
  return { notes: text.slice(0, index).trim(), invitees };
}

/** Wall clock time YYYY-MM-DDTHH:MM of an ISO instant in the given time zone. */
export function localTimeIn(isoTime, tzid) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(isoTime)) {
    return isoTime.slice(0, 16);
  }
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(format.formatToParts(new Date(isoTime)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Event-like view of a Zoom meeting that has no calendar event on this computer. */
export function toVirtualEvent(meeting, nowMs, fallbackTz) {
  const tzid = meeting.timezone || fallbackTz;
  const startMs = meeting.start_time ? Date.parse(meeting.start_time) : null;
  const durationMin = meeting.duration || DEFAULT_DURATION_MIN;
  return {
    zoomOnly: true,
    zoomRecurring: meeting.type === RECURRING_FIXED_TIME || meeting.type === RECURRING_NO_FIXED_TIME,
    uid: `zoom:${meeting.id}`,
    calendarId: null,
    calendarName: null,
    title: meeting.topic || "",
    description: splitAgenda(meeting.agenda).notes,
    startMs,
    endMs: startMs === null ? null : startMs + durationMin * 60000,
    startLocal: meeting.start_time ? localTimeIn(meeting.start_time, tzid) : null,
    tzid,
    durationMin,
    rrule: null,
    nextOccurrenceMs: startMs !== null && startMs >= nowMs ? startMs : null,
    attendees: [],
    zoomId: String(meeting.id),
    zoomJoinUrl: meeting.join_url || null,
    zoomPassword: null,
  };
}

/** One entry per meeting ID, keeping the nearest upcoming occurrence of a series. */
export function zoomListToEvents(meetings, nowMs, fallbackTz) {
  const byId = new Map();
  for (const meeting of meetings) {
    const event = toVirtualEvent(meeting, nowMs, fallbackTz);
    const current = byId.get(event.zoomId);
    if (!current || (event.nextOccurrenceMs ?? Infinity) < (current.nextOccurrenceMs ?? Infinity)) {
      byId.set(event.zoomId, event);
    }
  }
  return [...byId.values()];
}

/** Calendar events plus the Zoom meetings that none of them is linked to. */
export function mergeMeetings(calendarEvents, zoomEvents) {
  const linked = new Set(calendarEvents.map(e => e.zoomId));
  return [...calendarEvents, ...zoomEvents.filter(e => !linked.has(e.zoomId))];
}

/**
 * Schedule fields of a meeting returned by GET /meetings/{id}, or null when it
 * has no fixed time. A series starts at its first occurrence so that the
 * COUNT of the RRULE matches the number of occurrences in Zoom.
 */
export function eventFieldsFromZoom(meeting, fallbackTz) {
  const first = meeting.occurrences?.[0];
  const startTime = first?.start_time || meeting.start_time;
  if (meeting.type === RECURRING_NO_FIXED_TIME || !startTime) {
    return null;
  }
  const tzid = meeting.timezone || fallbackTz;
  const startLocal = localTimeIn(startTime, tzid);
  const recurrence = meeting.recurrence
    ? fromZoomRecurrence(meeting.recurrence, startLocal, meeting.occurrences?.length)
    : null;
  return {
    startLocal,
    tzid,
    durationMin: first?.duration || meeting.duration || DEFAULT_DURATION_MIN,
    rrule: toRRule(recurrence, startLocal),
  };
}
