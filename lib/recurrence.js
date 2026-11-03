// Recurrence model shared by the UI, the calendar (RRULE) and Zoom.
// model: { freq: "NONE"|"DAILY"|"WEEKLY"|"MONTHLY", interval, byDay: ["MO",...],
//          endType: "COUNT"|"UNTIL", count, until: "YYYY-MM-DD" }

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Zoom API limits for recurring meetings with fixed time.
export const ZOOM_LIMITS = { DAILY: 15, WEEKLY: 12, MONTHLY: 3, maxOccurrences: 60 };

export function defaultModel() {
  return { freq: "NONE", interval: 1, byDay: [], endType: "COUNT", count: 10, until: "" };
}

export function validate(model) {
  if (!model || model.freq === "NONE") {
    return null;
  }
  const max = ZOOM_LIMITS[model.freq];
  if (!(model.interval >= 1 && model.interval <= max)) {
    return { key: "errorRecurrenceInterval", subs: [String(max)] };
  }
  if (model.endType === "COUNT" && !(model.count >= 1 && model.count <= ZOOM_LIMITS.maxOccurrences)) {
    return { key: "errorRecurrenceCount", subs: [String(ZOOM_LIMITS.maxOccurrences)] };
  }
  if (model.endType === "UNTIL" && !/^\d{4}-\d{2}-\d{2}$/.test(model.until || "")) {
    return { key: "errorRecurrenceUntil", subs: [] };
  }
  if (model.freq === "WEEKLY" && !model.byDay.length) {
    return { key: "errorRecurrenceDays", subs: [] };
  }
  return null;
}

function dayOfMonth(startLocal) {
  return Number(startLocal.slice(8, 10));
}

export function toRRule(model, startLocal) {
  if (!model || model.freq === "NONE") {
    return "";
  }
  const parts = [`FREQ=${model.freq}`, `INTERVAL=${model.interval}`];
  if (model.freq === "WEEKLY") {
    parts.push(`BYDAY=${model.byDay.join(",")}`);
  }
  if (model.freq === "MONTHLY") {
    parts.push(`BYMONTHDAY=${dayOfMonth(startLocal)}`);
  }
  if (model.endType === "UNTIL") {
    parts.push(`UNTIL=${model.until.replace(/-/g, "")}T235959Z`);
  } else {
    parts.push(`COUNT=${model.count}`);
  }
  return parts.join(";");
}

export function fromRRule(rrule) {
  const model = defaultModel();
  if (!rrule) {
    return model;
  }
  const map = Object.fromEntries(
    rrule.split(";").map(p => {
      const [k, v] = p.split("=");
      return [k.toUpperCase(), v];
    })
  );
  model.freq = ["DAILY", "WEEKLY", "MONTHLY"].includes(map.FREQ) ? map.FREQ : "NONE";
  model.interval = Number(map.INTERVAL || 1);
  model.byDay = map.BYDAY ? map.BYDAY.split(",").map(d => d.replace(/^[+-]?\d+/, "")) : [];
  if (map.UNTIL) {
    model.endType = "UNTIL";
    model.until = `${map.UNTIL.slice(0, 4)}-${map.UNTIL.slice(4, 6)}-${map.UNTIL.slice(6, 8)}`;
  } else {
    model.endType = "COUNT";
    model.count = Number(map.COUNT || 10);
  }
  return model;
}

export function toZoomRecurrence(model, startLocal) {
  if (!model || model.freq === "NONE") {
    return null;
  }
  const recurrence = {
    type: { DAILY: 1, WEEKLY: 2, MONTHLY: 3 }[model.freq],
    repeat_interval: model.interval,
  };
  if (model.freq === "WEEKLY") {
    recurrence.weekly_days = model.byDay.map(d => WEEKDAYS.indexOf(d) + 1).sort().join(",");
  }
  if (model.freq === "MONTHLY") {
    recurrence.monthly_day = dayOfMonth(startLocal);
  }
  if (model.endType === "UNTIL") {
    recurrence.end_date_time = `${model.until}T23:59:59Z`;
  } else {
    recurrence.end_times = model.count;
  }
  return recurrence;
}
