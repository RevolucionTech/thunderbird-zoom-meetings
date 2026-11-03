import assert from "node:assert/strict";
import { toRRule, fromRRule, toZoomRecurrence, validate, defaultModel } from "../lib/recurrence.js";

const weekly = { freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"], endType: "COUNT", count: 6, until: "" };
assert.equal(toRRule(weekly, "2026-11-09T10:00"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6");
assert.deepEqual(toZoomRecurrence(weekly, "2026-11-09T10:00"), { type: 2, repeat_interval: 2, weekly_days: "2,4", end_times: 6 });
assert.deepEqual(fromRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6"), weekly);

const monthly = { freq: "MONTHLY", interval: 1, byDay: [], endType: "UNTIL", count: 10, until: "2027-03-31" };
assert.equal(toRRule(monthly, "2026-11-15T09:30"), "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15;UNTIL=20270331T235959Z");
assert.deepEqual(toZoomRecurrence(monthly, "2026-11-15T09:30"), { type: 3, repeat_interval: 1, monthly_day: 15, end_date_time: "2027-03-31T23:59:59Z" });
assert.equal(fromRRule(toRRule(monthly, "2026-11-15T09:30")).until, "2027-03-31");

assert.equal(toRRule(defaultModel(), "2026-11-15T09:30"), "");
assert.equal(toZoomRecurrence(defaultModel(), "x"), null);
assert.equal(validate({ ...weekly, byDay: [] }).key, "errorRecurrenceDays");
assert.equal(validate({ ...weekly, interval: 13 }).key, "errorRecurrenceInterval");
assert.equal(validate({ ...weekly, count: 61 }).key, "errorRecurrenceCount");
assert.equal(validate(weekly), null);
// Sunday maps to Zoom day 1
assert.equal(toZoomRecurrence({ ...weekly, byDay: ["SU", "SA"] }, "2026-11-09T10:00").weekly_days, "1,7");
console.log("recurrence tests passed");
