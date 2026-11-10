import assert from "node:assert/strict";
import { stripMozProperties, quotedPrintable, vcsRecurrence, toVcs, formatAddress, invitationFileName } from "../lib/invitation.js";

// X-MOZ-* properties go away, including folded continuation lines.
const ics = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:abc",
  "X-MOZ-SEND-INVITATIONS:TRUE",
  "X-MOZ-LONG:aaa",
  " bbb",
  "SUMMARY:Sync",
  " continued",
  "X-ZOOM-MEETING-ID:123",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");
assert.equal(
  stripMozProperties(ics),
  ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:abc", "SUMMARY:Sync", " continued", "X-ZOOM-MEETING-ID:123", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n")
);

// Quoted-printable: UTF-8, line breaks, "=" and soft breaks under 76 characters.
assert.equal(quotedPrintable("Reunión = sí\nhoy"), "Reuni=C3=B3n =3D s=C3=AD=0D=0Ahoy");
assert.equal(quotedPrintable("end "), "end=20");
const long = quotedPrintable("ñ".repeat(60), 40);
for (const line of long.split("\r\n")) assert.ok(line.length <= 76, line);
assert.ok(!/=[0-9A-F]?=\r\n/.test(long), "never splits an escape");
assert.equal(long.replace(/=\r\n/g, ""), "=C3=B1".repeat(60));

// vCalendar 1.0 recurrence.
assert.equal(vcsRecurrence(""), null);
assert.equal(vcsRecurrence("FREQ=DAILY;INTERVAL=2;COUNT=5"), "D2 #5");
assert.equal(vcsRecurrence("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6"), "W1 MO WE #6");
assert.equal(vcsRecurrence("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15;UNTIL=20270331T235959Z"), "MD1 15 20270331T235959Z");
assert.equal(vcsRecurrence("FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU;COUNT=4"), "MP1 2+ TU #4");
assert.equal(vcsRecurrence("FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR;COUNT=4"), "MP1 1- FR #4");

// Full .vcs.
const vcs = toVcs({
  uid: "abc",
  title: "Revisión",
  description: "Notas\nJoin: https://zoom.us/j/1",
  location: "https://zoom.us/j/1",
  startMs: Date.parse("2026-11-09T09:00:00Z"),
  endMs: Date.parse("2026-11-09T09:30:00Z"),
  rrule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=3",
  attendees: [{ email: "ana@example.com" }],
});
assert.ok(vcs.startsWith("BEGIN:VCALENDAR\r\nVERSION:1.0\r\n"));
assert.ok(vcs.includes("\r\nDTSTART:20261109T090000Z\r\nDTEND:20261109T093000Z\r\n"));
assert.ok(vcs.includes("\r\nSUMMARY;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Revisi=C3=B3n\r\n"));
assert.ok(vcs.replace(/=\r\n/g, "").includes("Notas=0D=0AJoin: https://zoom.us/j/1"));
assert.ok(vcs.includes("\r\nRRULE:W1 MO #3\r\n"));
assert.ok(vcs.includes("\r\nATTENDEE;ROLE=ATTENDEE;STATUS=NEEDS ACTION;RSVP=YES:ana@example.com\r\n"));
assert.ok(vcs.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
assert.ok(!/[^\r]\n/.test(vcs), "CRLF only");

// Addresses and file names.
assert.equal(formatAddress({ email: "a@b.c", name: 'Pérez, "Ana"' }), '"Pérez, Ana" <a@b.c>');
assert.equal(formatAddress({ email: "a@b.c", name: "" }), "a@b.c");
assert.equal(invitationFileName("Revisión semanal / Q4", "ics"), "Revision-semanal-Q4.ics");
assert.equal(invitationFileName("", "vcs"), "invitation.vcs");

console.log("invitation tests passed");
