import assert from "node:assert/strict";
import { localTimeIn, toVirtualEvent, zoomListToEvents, mergeMeetings, eventFieldsFromZoom } from "../lib/zoomEvents.js";
import { fromRRule, fromZoomRecurrence, toRRule, toZoomRecurrence } from "../lib/recurrence.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const TZ = "Europe/Madrid";

// Time zones, including a daylight saving change.
assert.equal(localTimeIn("2026-11-09T09:00:00Z", TZ), "2026-11-09T10:00");
assert.equal(localTimeIn("2026-07-09T09:00:00Z", TZ), "2026-07-09T11:00");
assert.equal(localTimeIn("2026-11-09T23:30:00Z", TZ), "2026-11-10T00:30");
assert.equal(localTimeIn("2026-11-09T10:00:00", TZ), "2026-11-09T10:00");

// A meeting listed by Zoom.
const listed = { id: 85012345678, type: 2, topic: "Sync", start_time: "2026-11-09T09:00:00Z", duration: 30, timezone: TZ, join_url: "https://zoom.us/j/1" };
const event = toVirtualEvent(listed, NOW, "UTC");
assert.equal(event.zoomId, "85012345678");
assert.equal(event.uid, "zoom:85012345678");
assert.equal(event.startLocal, "2026-11-09T10:00");
assert.equal(event.endMs - event.startMs, 30 * 60000);
assert.equal(event.nextOccurrenceMs, event.startMs);
assert.equal(event.zoomRecurring, false);

// Past meetings have no next occurrence; a missing time zone uses the fallback.
const past = toVirtualEvent({ ...listed, start_time: "2026-11-01T09:00:00Z", timezone: "" }, NOW, "UTC");
assert.equal(past.nextOccurrenceMs, null);
assert.equal(past.tzid, "UTC");

// Recurring meetings without fixed time have no start.
const noTime = toVirtualEvent({ id: 1, type: 3, topic: "Open room" }, NOW, TZ);
assert.equal(noTime.startMs, null);
assert.equal(noTime.endMs, null);
assert.equal(noTime.zoomRecurring, true);

// A series listed once per occurrence collapses to the nearest upcoming one.
const series = [
  { id: 7, type: 8, start_time: "2026-11-02T09:00:00Z", duration: 30 },
  { id: 7, type: 8, start_time: "2026-11-16T09:00:00Z", duration: 30 },
  { id: 7, type: 8, start_time: "2026-11-09T09:00:00Z", duration: 30 },
];
const collapsed = zoomListToEvents(series, NOW, TZ);
assert.equal(collapsed.length, 1);
assert.equal(collapsed[0].startMs, Date.parse("2026-11-09T09:00:00Z"));

// Only Zoom meetings without a calendar event are added to the list.
const merged = mergeMeetings(
  [{ uid: "a", zoomId: "1" }],
  [
    { uid: "zoom:1", zoomId: "1" },
    { uid: "zoom:2", zoomId: "2" },
  ]
);
assert.deepEqual(merged.map(e => e.uid), ["a", "zoom:2"]);

// Single meeting detail.
assert.deepEqual(eventFieldsFromZoom({ type: 2, start_time: "2026-11-09T09:00:00Z", duration: 45, timezone: TZ }, "UTC"), {
  startLocal: "2026-11-09T10:00",
  tzid: TZ,
  durationMin: 45,
  rrule: "",
});
assert.equal(eventFieldsFromZoom({ type: 3 }, TZ), null);

// A series is anchored on its first occurrence.
const weeklyDetail = {
  type: 8,
  start_time: "2026-11-16T09:00:00Z",
  duration: 30,
  timezone: TZ,
  recurrence: { type: 2, repeat_interval: 1, weekly_days: "2,4", end_times: 6 },
  occurrences: [
    { occurrence_id: "1", start_time: "2026-11-02T09:00:00Z", duration: 30 },
    { occurrence_id: "2", start_time: "2026-11-04T09:00:00Z", duration: 30 },
  ],
};
const weeklyFields = eventFieldsFromZoom(weeklyDetail, "UTC");
assert.equal(weeklyFields.startLocal, "2026-11-02T10:00");
assert.equal(weeklyFields.rrule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=6");

// Zoom recurrence to RRULE.
assert.equal(toRRule(fromZoomRecurrence({ type: 1, repeat_interval: 2, end_times: 5 }, "2026-11-09T10:00"), "2026-11-09T10:00"), "FREQ=DAILY;INTERVAL=2;COUNT=5");
assert.equal(
  toRRule(fromZoomRecurrence({ type: 3, repeat_interval: 1, monthly_day: 15, end_date_time: "2027-03-31T22:59:00Z" }, "2026-11-15T10:00"), "2026-11-15T10:00"),
  "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15;UNTIL=20270331T235959Z"
);
// Weekly without days falls back to the weekday of the start (2026-11-09 is a Monday).
assert.equal(fromZoomRecurrence({ type: 2, repeat_interval: 1, end_times: 2 }, "2026-11-09T10:00").byDay[0], "MO");
// Without an explicit end, the number of occurrences is used.
assert.equal(fromZoomRecurrence({ type: 1, repeat_interval: 1 }, "2026-11-09T10:00", 12).count, 12);

// "Second Tuesday of the month" survives Zoom -> RRULE -> Zoom.
const nthZoom = { type: 3, repeat_interval: 1, monthly_week: 2, monthly_week_day: 3, end_times: 4 };
const nthRule = toRRule(fromZoomRecurrence(nthZoom, "2026-11-10T10:00"), "2026-11-10T10:00");
assert.equal(nthRule, "FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU;COUNT=4");
assert.deepEqual(toZoomRecurrence(fromRRule(nthRule), "2026-11-10T10:00"), nthZoom);
// "Last Friday" uses a negative week.
assert.equal(
  toRRule(fromZoomRecurrence({ type: 3, repeat_interval: 1, monthly_week: -1, monthly_week_day: 6, end_times: 4 }, "2026-11-27T10:00"), "2026-11-27T10:00"),
  "FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR;COUNT=4"
);

console.log("zoom events tests passed");
