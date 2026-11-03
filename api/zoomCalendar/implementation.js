/* Experiment API: bridge between the extension and Thunderbird's native
 * calendar (calICalendar) and iTIP (invitations, updates, cancellations). */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
var { CalAttendee } = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
var { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");

var { ExtensionError } = ExtensionUtils;

var ZOOM_ID_PROP = "X-ZOOM-MEETING-ID";
var ZOOM_URL_PROP = "X-ZOOM-JOIN-URL";
var ZOOM_PWD_PROP = "X-ZOOM-PASSWORD";

function pad(n) {
  return String(n).padStart(2, "0");
}

function emailOf(id) {
  return cal.email.removeMailTo(id || "").toLowerCase();
}

function toMs(dt) {
  return dt ? dt.nativeTime / 1000 : null;
}

function localString(dt) {
  return `${dt.year}-${pad(dt.month + 1)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}`;
}

function buildDateTime(local, tzid) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || "");
  if (!m) {
    throw new ExtensionError(`Invalid local date: ${local}`);
  }
  const tz = (tzid && cal.timezoneService.getTimezone(tzid)) || cal.dtz.defaultTimezone;
  const dt = cal.createDateTime();
  dt.resetTo(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, tz);
  return dt;
}

function getCalendar(calendarId) {
  const calendar = cal.manager.getCalendarById(calendarId);
  if (!calendar) {
    throw new ExtensionError(`Calendar not found: ${calendarId}`);
  }
  return calendar;
}

function rruleOf(item) {
  const info = item.recurrenceInfo;
  if (!info) {
    return null;
  }
  const rules = info
    .getRecurrenceItems()
    .filter(r => !r.isNegative && /^RRULE:/i.test(r.icalString || ""))
    .map(r => r.icalString.trim().replace(/^RRULE:/i, ""));
  return rules[0] || null;
}

function nextOccurrenceMs(item) {
  const now = cal.dtz.now();
  if (item.recurrenceInfo) {
    const next = item.recurrenceInfo.getNextOccurrence(now);
    return next ? toMs(next.startDate) : null;
  }
  return item.startDate && item.startDate.compare(now) >= 0 ? toMs(item.startDate) : null;
}

function serializeAttendee(att) {
  return {
    email: emailOf(att.id),
    name: att.commonName || "",
    partstat: att.participationStatus || "NEEDS-ACTION",
    role: att.role || "REQ-PARTICIPANT",
  };
}

function serializeEvent(item) {
  const start = item.startDate;
  const end = item.endDate || start;
  const organizer = item.organizer;
  return {
    uid: item.id,
    calendarId: item.calendar ? item.calendar.id : null,
    calendarName: item.calendar ? item.calendar.name : null,
    title: item.title || "",
    description: item.getProperty("DESCRIPTION") || "",
    location: item.getProperty("LOCATION") || "",
    status: item.getProperty("STATUS") || "",
    sequence: Number(item.getProperty("SEQUENCE") || 0),
    allDay: !!(start && start.isDate),
    startMs: toMs(start),
    endMs: toMs(end),
    startLocal: start ? localString(start) : null,
    tzid: start && !start.timezone.isFloating ? start.timezone.tzid : null,
    durationMin: start && end ? Math.round((end.nativeTime - start.nativeTime) / 60e6) : 0,
    rrule: rruleOf(item),
    nextOccurrenceMs: nextOccurrenceMs(item),
    organizer: organizer ? { email: emailOf(organizer.id), name: organizer.commonName || "" } : null,
    attendees: item
      .getAttendees()
      .filter(a => !a.isOrganizer)
      .map(serializeAttendee),
    zoomId: item.getProperty(ZOOM_ID_PROP) || null,
    zoomJoinUrl: item.getProperty(ZOOM_URL_PROP) || null,
    zoomPassword: item.getProperty(ZOOM_PWD_PROP) || null,
  };
}

function makeAttendee(email, name, partstat) {
  const att = new CalAttendee();
  att.id = cal.email.prependMailTo(email.trim());
  if (name) {
    att.commonName = name;
  }
  att.role = "REQ-PARTICIPANT";
  att.participationStatus = partstat || "NEEDS-ACTION";
  att.rsvp = "TRUE";
  att.userType = "INDIVIDUAL";
  return att;
}

function setRecurrence(item, rrule) {
  if (rrule === undefined || rrule === null) {
    return;
  }
  if (!rrule) {
    item.recurrenceInfo = null;
    return;
  }
  const info = new CalRecurrenceInfo(item);
  info.appendRecurrenceItem(cal.createRecurrenceRule("RRULE:" + rrule));
  item.recurrenceInfo = info;
}

/**
 * Applies EventInput fields to a mutable item. Returns true when a change
 * affects the schedule (time or recurrence), which resets attendee replies,
 * as Outlook does.
 */
function applyInput(item, data, isNew) {
  let scheduleChanged = isNew;
  if (data.title !== undefined) {
    item.title = data.title;
  }
  if (data.description !== undefined) {
    item.setProperty("DESCRIPTION", data.description);
  }
  if (data.location !== undefined) {
    item.setProperty("LOCATION", data.location);
  }
  if (data.startLocal !== undefined || data.durationMin !== undefined || data.tzid !== undefined) {
    const tzid = data.tzid || (item.startDate && item.startDate.timezone.tzid);
    const startLocal = data.startLocal || localString(item.startDate);
    const durationMin =
      data.durationMin !== undefined
        ? data.durationMin
        : Math.round((item.endDate.nativeTime - item.startDate.nativeTime) / 60e6);
    const start = buildDateTime(startLocal, tzid);
    const end = start.clone();
    const duration = cal.createDuration();
    duration.inSeconds = Math.max(1, durationMin) * 60;
    end.addDuration(duration);
    if (!item.startDate || item.startDate.compare(start) != 0 || item.endDate.compare(end) != 0) {
      scheduleChanged = true;
    }
    item.startDate = start;
    item.endDate = end;
  }
  if (data.rrule !== undefined && data.rrule !== null) {
    if ((rruleOf(item) || "") != data.rrule) {
      scheduleChanged = true;
    }
    setRecurrence(item, data.rrule);
  }
  if (data.zoom) {
    item.setProperty(ZOOM_ID_PROP, String(data.zoom.id));
    item.setProperty(ZOOM_URL_PROP, data.zoom.joinUrl);
    if (data.zoom.password) {
      item.setProperty(ZOOM_PWD_PROP, data.zoom.password);
    } else {
      item.deleteProperty(ZOOM_PWD_PROP);
    }
  }
  if (data.attendees) {
    const previous = new Map(item.getAttendees().map(a => [emailOf(a.id), a]));
    const organizerEmail = item.organizer ? emailOf(item.organizer.id) : null;
    item.removeAllAttendees();
    for (const input of data.attendees) {
      const email = (input.email || "").trim().toLowerCase();
      if (!email || email == organizerEmail) {
        continue;
      }
      const old = previous.get(email);
      const partstat = old && !scheduleChanged ? old.participationStatus : "NEEDS-ACTION";
      item.addAttendee(makeAttendee(email, input.name || (old && old.commonName), partstat));
    }
  } else if (scheduleChanged && !isNew) {
    for (const att of item.getAttendees()) {
      const copy = att.clone();
      copy.participationStatus = "NEEDS-ACTION";
      item.removeAttendee(att);
      item.addAttendee(copy);
    }
  }
}

function sendItip(opType, item, oldItem) {
  // AUTO avoids Thunderbird's "send invitations?" prompt: the extension UI already asked.
  cal.itip.checkAndSend(opType, item, oldItem, { responseMode: Ci.calIItipItem.AUTO });
}

async function getAllEvents(calendars, rangeStart, rangeEnd) {
  const results = [];
  for (const calendar of calendars) {
    if (calendar.getProperty("disabled")) {
      continue;
    }
    try {
      const items = await calendar.getItemsAsArray(
        Ci.calICalendar.ITEM_FILTER_TYPE_EVENT,
        0,
        rangeStart,
        rangeEnd
      );
      results.push(...items);
    } catch (e) {
      console.error(`zoomCalendar: cannot read calendar ${calendar.name}`, e);
    }
  }
  return results;
}

this.zoomCalendar = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      zoomCalendar: {
        async listCalendars() {
          return cal.manager.getCalendars().map(calendar => {
            const identity = cal.provider.getEmailIdentityOfCalendar(calendar);
            return {
              id: calendar.id,
              name: calendar.name,
              type: calendar.type,
              disabled: !!calendar.getProperty("disabled"),
              readOnly: !!calendar.readOnly,
              canSchedule: !!cal.itip.isSchedulingCalendar(calendar),
              identityEmail: identity ? identity.email : null,
              color: calendar.getProperty("color") || null,
            };
          });
        },

        async listEvents(filter) {
          const calendars = filter.calendarId
            ? [getCalendar(filter.calendarId)]
            : cal.manager.getCalendars();
          const rangeStart = filter.rangeStartMs
            ? cal.dtz.jsDateToDateTime(new Date(filter.rangeStartMs), cal.dtz.UTC)
            : null;
          const rangeEnd = filter.rangeEndMs
            ? cal.dtz.jsDateToDateTime(new Date(filter.rangeEndMs), cal.dtz.UTC)
            : null;
          const items = await getAllEvents(calendars, rangeStart, rangeEnd);
          return items
            .filter(item => !filter.zoomOnly || item.getProperty(ZOOM_ID_PROP))
            .map(serializeEvent);
        },

        async getEvent(calendarId, uid) {
          const item = await getCalendar(calendarId).getItem(uid);
          return item ? serializeEvent(item) : null;
        },

        async findEventByUid(uid) {
          for (const calendar of cal.manager.getCalendars()) {
            if (calendar.getProperty("disabled")) {
              continue;
            }
            try {
              const item = await calendar.getItem(uid);
              if (item) {
                return serializeEvent(item);
              }
            } catch (e) {
              console.error(`zoomCalendar: lookup failed in ${calendar.name}`, e);
            }
          }
          return null;
        },

        async createEvent(calendarId, data, sendInvitations) {
          const calendar = getCalendar(calendarId);
          if (!cal.acl.isCalendarWritable(calendar)) {
            throw new ExtensionError(`Calendar is read only: ${calendar.name}`);
          }
          const item = new CalEvent();
          item.id = cal.getUUID();
          item.calendar = calendar;
          const organizer = cal.itip.createOrganizer(calendar);
          if (data.attendees && data.attendees.length) {
            if (!organizer) {
              throw new ExtensionError(
                `Calendar "${calendar.name}" has no email identity; set one in its properties to send invitations.`
              );
            }
            item.organizer = organizer;
          }
          applyInput(item, data, true);
          item.setProperty("X-MOZ-SEND-INVITATIONS", sendInvitations ? "TRUE" : "FALSE");
          item.setProperty("X-MOZ-SEND-INVITATIONS-UNDISCLOSED", "FALSE");
          const added = await calendar.addItem(item);
          if (sendInvitations) {
            sendItip(Ci.calIOperationListener.ADD, added, null);
          }
          return serializeEvent(added);
        },

        async updateEvent(calendarId, uid, data, sendUpdates) {
          const calendar = getCalendar(calendarId);
          const oldItem = await calendar.getItem(uid);
          if (!oldItem) {
            throw new ExtensionError(`Event not found: ${uid}`);
          }
          const item = oldItem.clone();
          if (data.attendees && data.attendees.length && !item.organizer) {
            const organizer = cal.itip.createOrganizer(calendar);
            if (!organizer) {
              throw new ExtensionError(`Calendar "${calendar.name}" has no email identity.`);
            }
            item.organizer = organizer;
          }
          applyInput(item, data, false);
          item.setProperty("X-MOZ-SEND-INVITATIONS", sendUpdates ? "TRUE" : "FALSE");
          const modified = await calendar.modifyItem(cal.itip.prepareSequence(item, oldItem), oldItem);
          if (sendUpdates) {
            sendItip(Ci.calIOperationListener.MODIFY, modified, oldItem);
          }
          return serializeEvent(modified);
        },

        async cancelEvent(calendarId, uid, notify) {
          const calendar = getCalendar(calendarId);
          const item = await calendar.getItem(uid);
          if (!item) {
            throw new ExtensionError(`Event not found: ${uid}`);
          }
          await calendar.deleteItem(item);
          if (notify && item.getAttendees().length) {
            const toSend = item.clone();
            toSend.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
            sendItip(Ci.calIOperationListener.DELETE, toSend, toSend);
          }
          return true;
        },

        async parseIcs(icsText) {
          const parser = Cc["@mozilla.org/calendar/ics-parser;1"].createInstance(Ci.calIIcsParser);
          parser.parseString(icsText);
          const method = (/^METHOD:(.+)$/im.exec(icsText) || [])[1];
          const items = parser.getItems().concat(parser.getParentlessItems());
          return {
            method: method ? method.trim().toUpperCase() : null,
            uids: [...new Set(items.map(i => i.id))],
          };
        },

        async applyItipReply(icsText) {
          const parser = Cc["@mozilla.org/calendar/ics-parser;1"].createInstance(Ci.calIIcsParser);
          parser.parseString(icsText);
          const replies = parser.getItems().concat(parser.getParentlessItems());
          const result = { matched: false, uid: null, title: null, updates: [] };
          for (const reply of replies) {
            const uid = reply.id;
            let found = null;
            for (const calendar of cal.manager.getCalendars()) {
              if (calendar.getProperty("disabled") || !cal.acl.isCalendarWritable(calendar)) {
                continue;
              }
              const candidate = await calendar.getItem(uid).catch(() => null);
              if (candidate) {
                found = candidate;
                break;
              }
            }
            if (!found) {
              continue;
            }
            result.matched = true;
            result.uid = uid;
            result.title = found.title;
            result.calendarId = found.calendar.id;

            const master = found.clone();
            let target = master;
            if (reply.recurrenceId && master.recurrenceInfo) {
              target = master.recurrenceInfo.getOccurrenceFor(reply.recurrenceId);
              if (!target) {
                continue;
              }
              target = target.clone();
            }
            let changed = false;
            for (const replyAtt of reply.getAttendees()) {
              const email = emailOf(replyAtt.id);
              const current = target.getAttendees().find(a => emailOf(a.id) == email);
              const partstat = replyAtt.participationStatus || "NEEDS-ACTION";
              if (!current || current.participationStatus == partstat) {
                continue;
              }
              const copy = current.clone();
              copy.participationStatus = partstat;
              target.removeAttendee(current);
              target.addAttendee(copy);
              result.updates.push({ email, partstat, recurrenceId: reply.recurrenceId ? reply.recurrenceId.icalString : null });
              changed = true;
            }
            if (!changed) {
              continue;
            }
            if (target !== master) {
              master.recurrenceInfo.modifyException(target, true);
            }
            await found.calendar.modifyItem(master, found);
          }
          return result;
        },

        async openCalendarTab() {
          const win = Services.wm.getMostRecentWindow("mail:3pane");
          if (win && win.tabmail) {
            win.tabmail.openTab("calendar");
            win.focus();
          }
        },

        onEventChanged: new ExtensionCommon.EventManager({
          context,
          name: "zoomCalendar.onEventChanged",
          register: fire => {
            const emit = (item, changeType) => {
              try {
                if (item && item.getProperty(ZOOM_ID_PROP) && !item.recurrenceId) {
                  fire.async(serializeEvent(item), changeType);
                }
              } catch (e) {
                console.error("zoomCalendar: observer failed", e);
              }
            };
            const observer = {
              QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
              onStartBatch() {},
              onEndBatch() {},
              onLoad() {},
              onError() {},
              onPropertyChanged() {},
              onPropertyDeleting() {},
              onAddItem(item) {
                emit(item, "added");
              },
              onModifyItem(newItem) {
                emit(newItem, "modified");
              },
              onDeleteItem(item) {
                emit(item, "deleted");
              },
            };
            cal.manager.addCalendarObserver(observer);
            return () => cal.manager.removeCalendarObserver(observer);
          },
        }).api(),
      },
    };
  }
};
