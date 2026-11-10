// Invitation files attached to a free-text email: iCalendar (.ics) and vCalendar 1.0 (.vcs).
import { fromRRule } from "./recurrence.js";

const CRLF = "\r\n";
const QP_LINE_LENGTH = 75;

/** Removes Thunderbird-internal X-MOZ-* properties (and their folded lines) from an iCalendar text. */
export function stripMozProperties(ics) {
  const kept = [];
  let skipping = false;
  for (const line of ics.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^X-MOZ-/i.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join(CRLF).replace(/(\r\n)*$/, CRLF);
}

/** Quoted-printable encoding of UTF-8 text with soft line breaks, as vCalendar 1.0 expects. */
export function quotedPrintable(text, firstLineOffset = 0) {
  const tokens = [];
  for (const byte of new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"))) {
    const printable = byte >= 33 && byte <= 126 && byte !== 61;
    tokens.push(printable || byte === 32 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  let result = "";
  let column = firstLineOffset;
  for (const token of tokens) {
    if (column + token.length > QP_LINE_LENGTH) {
      result += `=${CRLF}`;
      column = 0;
    }
    result += token;
    column += token.length;
  }
  // A trailing space would be lost by mail transports.
  return result.replace(/ $/, "=20");
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** vCalendar 1.0 RRULE value, e.g. "W1 MO WE #6", or null. */
export function vcsRecurrence(rrule) {
  if (!rrule) return null;
  const model = fromRRule(rrule);
  let rule;
  if (model.freq === "DAILY") {
    rule = `D${model.interval}`;
  } else if (model.freq === "WEEKLY") {
    rule = `W${model.interval} ${model.byDay.join(" ")}`;
  } else if (model.freq === "MONTHLY" && model.nth) {
    const week = model.nth.week < 0 ? `${-model.nth.week}-` : `${model.nth.week}+`;
    rule = `MP${model.interval} ${week} ${model.nth.day}`;
  } else if (model.freq === "MONTHLY") {
    const day = /BYMONTHDAY=(\d+)/.exec(rrule);
    rule = `MD${model.interval}${day ? ` ${day[1]}` : ""}`;
  } else {
    return null;
  }
  const end = model.endType === "UNTIL" ? `${model.until.replace(/-/g, "")}T235959Z` : `#${model.count}`;
  return `${rule} ${end}`;
}

function textProperty(name, value) {
  const prefix = `${name};CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:`;
  return prefix + quotedPrintable(value, prefix.length);
}

/** vCalendar 1.0 version of a calendar event (as returned by the zoomCalendar API). */
export function toVcs(event) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:1.0",
    "PRODID:-//RevolucionTech//Zoom Meetings for Thunderbird//EN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTART:${utcStamp(event.startMs)}`,
    `DTEND:${utcStamp(event.endMs)}`,
    textProperty("SUMMARY", event.title || ""),
  ];
  if (event.description) lines.push(textProperty("DESCRIPTION", event.description));
  if (event.location) lines.push(textProperty("LOCATION", event.location));
  const recurrence = vcsRecurrence(event.rrule);
  if (recurrence) lines.push(`RRULE:${recurrence}`);
  for (const attendee of event.attendees || []) {
    lines.push(`ATTENDEE;ROLE=ATTENDEE;STATUS=NEEDS ACTION;RSVP=YES:${attendee.email}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

/** RFC 5322 address with a quoted display name. */
export function formatAddress({ email, name }) {
  const clean = (name || "").replace(/["\\\r\n]/g, "").trim();
  return clean ? `"${clean}" <${email}>` : email;
}

/** File name derived from the meeting title. */
export function invitationFileName(title, extension) {
  const base = (title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "invitation"}.${extension}`;
}
