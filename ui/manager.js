// Meeting manager tab: list, detail with attendee tracking, create/edit form.
import * as meetings from "../lib/meetings.js";
import * as zoom from "../lib/zoom.js";
import { defaultModel, WEEKDAYS, ZOOM_LIMITS } from "../lib/recurrence.js";
import { mergeMeetings } from "../lib/zoomEvents.js";

const t = (key, subs) => browser.i18n.getMessage(key.replace(/-/g, "_"), subs) || key;
const $ = id => document.getElementById(id);
const locale = browser.i18n.getUILanguage();
const MISSING_SCOPE_CODE = 4711;

const state = {
  filter: "upcoming",
  events: [],
  zoomMeetings: [],
  calendars: [],
  selected: null,
  editing: null,
  attendees: [],
  zoomConnected: false,
};

// ---- helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

function localize() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
}

function showBanner(message, kind = "error") {
  const banner = $("banner");
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.hidden = false;
  clearTimeout(showBanner.timer);
  showBanner.timer = setTimeout(() => (banner.hidden = true), kind === "error" ? 10000 : 5000);
}

async function guarded(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    showBanner(e.message || String(e));
  } finally {
    if (button) button.disabled = false;
  }
}

function formatWhen(event, ms = event.nextOccurrenceMs || event.startMs) {
  if (ms === null) return t("noFixedTime");
  const tz = event.tzid || undefined;
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: tz });
  const end = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: tz });
  return `${fmt.format(ms)} – ${end.format(ms + event.durationMin * 60000)}${tz ? ` (${tz})` : ""}`;
}

function describeRecurrence(event) {
  if (!event.rrule) return "";
  const model = meetings.formFromEvent(event).recurrence;
  const unit = t(`unit_${model.freq}`);
  let text = t("recurrenceEvery", [String(model.interval), unit]);
  if (model.freq === "WEEKLY" && model.byDay.length) {
    text += ` · ${model.byDay.map(d => t(`day_${d}`)).join(", ")}`;
  }
  text += " · " + (model.endType === "UNTIL" ? t("recurrenceUntil", [model.until]) : t("recurrenceCount", [String(model.count)]));
  return text;
}

function isPast(event) {
  // The Zoom list does not tell when a series ends; it only returns unexpired meetings.
  if (event.zoomRecurring) return false;
  const reference = event.nextOccurrenceMs || event.endMs;
  return !event.nextOccurrenceMs && reference < Date.now();
}

function partstatClass(partstat) {
  return { ACCEPTED: "ok", DECLINED: "bad", TENTATIVE: "maybe" }[partstat] || "pending";
}

// ---- Zoom status -------------------------------------------------------------

async function renderZoomStatus() {
  const box = $("zoomStatus");
  box.replaceChildren();
  const status = await zoom.status();
  state.zoomConnected = status.connected;
  if (status.connected) {
    box.append(el("span", { class: "dot ok" }), el("span", { text: t("zoomConnectedAs", [status.user?.email || "OK"]) }));
  } else {
    box.append(
      el("span", { class: "dot bad" }),
      el("span", { text: t("zoomNotConnected") }),
      el("button", { class: "link", text: t("actionConnect"), onclick: () => browser.runtime.openOptionsPage() })
    );
  }
}

// ---- list ------------------------------------------------------------------

async function loadEvents() {
  state.calendars = await messenger.zoomCalendar.listCalendars();
  state.events = await messenger.zoomCalendar.listEvents({ zoomOnly: true });
  renderList();
}

async function loadZoomMeetings() {
  if (!state.zoomConnected) {
    state.zoomMeetings = [];
    return;
  }
  try {
    state.zoomMeetings = await meetings.listZoomMeetings();
  } catch (e) {
    console.error(e);
    showBanner(e.code === MISSING_SCOPE_CODE ? t("errorZoomListScope") : e.message || String(e));
  }
}

function allMeetings() {
  return mergeMeetings(state.events, state.zoomMeetings);
}

function sortKey(event) {
  return event.nextOccurrenceMs || event.startMs || Number.MAX_SAFE_INTEGER;
}

function renderList() {
  const list = $("meetingList");
  list.replaceChildren();
  const events = allMeetings()
    .filter(e => (state.filter === "past" ? isPast(e) : !isPast(e)))
    .sort((a, b) => (state.filter === "past" ? sortKey(b) - sortKey(a) : sortKey(a) - sortKey(b)));
  $("emptyList").hidden = events.length > 0;
  for (const event of events) {
    const s = meetings.stats(event);
    const item = el(
      "li",
      {
        class: `meeting-item${state.selected && state.selected.uid === event.uid ? " selected" : ""}`,
        onclick: () => selectEvent(event),
      },
      el("div", { class: "mi-title", text: event.title || t("untitled") }),
      el("div", { class: "mi-when muted small", text: formatWhen(event) }),
      el(
        "div",
        { class: "mi-badges" },
        event.zoomOnly ? el("span", { class: "pill maybe", text: t("notInCalendar") }) : null,
        event.rrule || event.zoomRecurring ? el("span", { class: "pill", text: t("recurring") }) : null,
        s.total ? el("span", { class: "pill ok", text: `✓ ${s.accepted}` }) : null,
        s.total ? el("span", { class: "pill pending", text: `? ${s.pending + s.tentative}` }) : null,
        s.total ? el("span", { class: "pill bad", text: `✗ ${s.declined}` }) : null
      )
    );
    list.append(item);
  }
}

// ---- detail ----------------------------------------------------------------

function showPane(name) {
  for (const id of ["placeholder", "detail", "form", "existing"]) {
    $(id).hidden = id !== name;
  }
}

async function selectEvent(event) {
  const fresh = event.zoomOnly
    ? await meetings.zoomMeetingDetail(event).catch(e => (console.error(e), event))
    : (await messenger.zoomCalendar.getEvent(event.calendarId, event.uid)) || event;
  state.selected = fresh;
  renderList();
  renderDetail(fresh);
}

function renderDetail(event) {
  showPane("detail");
  $("cancelConfirm").hidden = true;
  $("dTitle").textContent = event.title || t("untitled");
  $("dWhen").textContent = formatWhen(event);
  $("dRecurrence").textContent = describeRecurrence(event);
  $("dCalendar").textContent = event.zoomOnly ? t("notInCalendar") : t("inCalendar", [event.calendarName || ""]);
  const noFixedTime = event.startMs === null;
  $("dCalendarOnly").hidden = !!event.zoomOnly;
  $("dAddCalendar").hidden = !event.zoomOnly || noFixedTime;
  $("dNoFixedTime").hidden = !event.zoomOnly || !noFixedTime;
  if (event.zoomOnly) fillCalendars(null, $("dCalendarSelect"));
  $("dInvitees").hidden = !event.zoomOnly || !event.invitees?.length;
  $("dInvitees").textContent = event.invitees?.length
    ? t("inviteesFromZoom", [event.invitees.map(a => a.name || a.email).join(", ")])
    : "";
  $("dState").textContent = isPast(event) ? t("statePast") : t("stateScheduled");
  $("dState").className = `pill ${isPast(event) ? "" : "ok"}`;
  $("dJoinUrl").textContent = event.zoomJoinUrl || "";
  $("dJoinUrl").onclick = e => {
    e.preventDefault();
    guarded(null, () => meetings.joinMeeting(event));
  };
  $("dZoomMeta").textContent = [
    `${t("inviteMeetingId")}: ${event.zoomId}`,
    event.zoomPassword ? `${t("invitePasscode")}: ${event.zoomPassword}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const s = meetings.stats(event);
  const stats = $("dStats");
  stats.replaceChildren(
    statCard(s.total, t("statInvited"), ""),
    statCard(s.accepted, t("statAccepted"), "ok"),
    statCard(s.tentative, t("statTentative"), "maybe"),
    statCard(s.pending, t("statPending"), "pending"),
    statCard(s.declined, t("statDeclined"), "bad")
  );

  const list = $("dAttendees");
  list.replaceChildren();
  if (!event.attendees.length) {
    list.append(el("li", { class: "muted", text: t("noAttendees") }));
  }
  const order = { ACCEPTED: 0, TENTATIVE: 1, "NEEDS-ACTION": 2, DECLINED: 3 };
  for (const a of [...event.attendees].sort((x, y) => (order[x.partstat] ?? 2) - (order[y.partstat] ?? 2))) {
    list.append(
      el(
        "li",
        {},
        el("div", {}, el("strong", { text: a.name || a.email }), a.name ? el("div", { class: "muted small", text: a.email }) : null),
        el("span", { class: `pill ${partstatClass(a.partstat)}`, text: t(`partstat_${a.partstat}`) || a.partstat })
      )
    );
  }
}

function statCard(value, label, kind) {
  return el("div", { class: `stat ${kind}` }, el("div", { class: "stat-value", text: String(value) }), el("div", { class: "stat-label", text: label }));
}

// ---- form ------------------------------------------------------------------

function fillTimezones(selected) {
  const select = $("fTimezone");
  if (!select.options.length) {
    const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [selected];
    for (const zone of zones) select.append(el("option", { value: zone, text: zone }));
  }
  if (![...select.options].some(o => o.value === selected)) select.append(el("option", { value: selected, text: selected }));
  select.value = selected;
}

function fillCalendars(selectedId, select = $("fCalendar")) {
  select.replaceChildren();
  const usable = state.calendars.filter(c => !c.disabled && !c.readOnly);
  for (const c of usable) {
    const label = c.canSchedule ? `${c.name} (${c.identityEmail})` : `${c.name} · ${t("calendarNoIdentity")}`;
    select.append(el("option", { value: c.id, text: label }));
  }
  const preferred = selectedId || usable.find(c => c.canSchedule)?.id || usable[0]?.id;
  if (preferred) select.value = preferred;
}

function fillWeekdays(selected) {
  const box = $("fWeekdays");
  box.replaceChildren();
  // Monday first, as in most European calendars.
  for (const day of ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]) {
    const input = el("input", { type: "checkbox", value: day });
    input.checked = selected.includes(day);
    box.append(el("label", { class: "check day" }, input, el("span", { text: t(`day_${day}`) })));
  }
}

function renderChips() {
  const box = $("fChips");
  box.replaceChildren();
  for (const a of state.attendees) {
    box.append(
      el(
        "span",
        { class: "chip", title: a.email },
        el("span", { text: a.name ? `${a.name} <${a.email}>` : a.email }),
        el("button", {
          type: "button",
          class: "chip-x",
          "aria-label": t("actionRemove"),
          text: "×",
          onclick: () => {
            state.attendees = state.attendees.filter(x => x.email !== a.email);
            renderChips();
          },
        })
      )
    );
  }
}

function addAttendee(email, name = "") {
  email = (email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showBanner(t("errorInvalidEmail", [email]));
    return false;
  }
  if (!state.attendees.some(a => a.email === email)) {
    state.attendees.push({ email, name });
    renderChips();
  }
  return true;
}

function contactToEntries(node) {
  const props = node.properties || {};
  const entries = [];
  const name = props.DisplayName || [props.FirstName, props.LastName].filter(Boolean).join(" ");
  for (const key of ["PrimaryEmail", "SecondEmail"]) {
    if (props[key]) entries.push({ email: props[key], name });
  }
  if (!entries.length && node.vCard) {
    const fn = (/^FN[^:]*:(.*)$/im.exec(node.vCard) || [])[1] || "";
    for (const m of node.vCard.matchAll(/^EMAIL[^:]*:(.*)$/gim)) entries.push({ email: m[1].trim(), name: fn.trim() });
  }
  return entries;
}

let searchTimer = null;
function setupAutocomplete() {
  const input = $("fAttendeeInput");
  const box = $("fSuggestions");
  let active = -1;
  let current = [];

  const close = () => {
    box.hidden = true;
    active = -1;
  };
  const pick = entry => {
    if (addAttendee(entry.email, entry.name)) input.value = "";
    close();
    input.focus();
  };
  const render = () => {
    box.replaceChildren();
    current.forEach((entry, i) => {
      box.append(
        el(
          "li",
          { class: i === active ? "active" : "", onmousedown: e => (e.preventDefault(), pick(entry)) },
          el("strong", { text: entry.name || entry.email }),
          entry.name ? el("span", { class: "muted small", text: ` ${entry.email}` }) : null
        )
      );
    });
    box.hidden = current.length === 0;
  };

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    if (query.length < 2) return close();
    searchTimer = setTimeout(async () => {
      try {
        const nodes = await messenger.contacts.quickSearch(query);
        const seen = new Set(state.attendees.map(a => a.email));
        current = nodes
          .flatMap(contactToEntries)
          .filter(e => !seen.has(e.email.toLowerCase()) && seen.add(e.email.toLowerCase()))
          .slice(0, 8);
        active = current.length ? 0 : -1;
        render();
      } catch (e) {
        console.error(e);
      }
    }, 150);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" && current.length) {
      active = (active + 1) % current.length;
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp" && current.length) {
      active = (active - 1 + current.length) % current.length;
      render();
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") {
      if (!box.hidden && active >= 0) {
        e.preventDefault();
        pick(current[active]);
      } else if (input.value.trim()) {
        e.preventDefault();
        for (const part of input.value.split(/[,;\s]+/).filter(Boolean)) addAttendee(part);
        input.value = "";
        close();
      }
    } else if (e.key === "Backspace" && !input.value && state.attendees.length) {
      state.attendees.pop();
      renderChips();
    } else if (e.key === "Escape") {
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}

function updateRecurrenceVisibility() {
  const freq = $("fFreq").value;
  for (const node of document.querySelectorAll(".recur-only")) node.hidden = freq === "NONE";
  for (const node of document.querySelectorAll(".weekly-only")) node.hidden = freq !== "WEEKLY";
  if (freq !== "NONE") {
    $("fIntervalUnit").textContent = t(`unit_${freq}`);
    $("fInterval").max = String(ZOOM_LIMITS[freq]);
  }
}

function roundedNow() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(0, 0, 0);
  return d;
}

function toLocalParts(date) {
  const pad = n => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function openForm(event = null, prefill = null) {
  state.editing = event;
  const form = event ? meetings.formFromEvent(event) : null;
  $("formTitle").textContent = event ? t("formEditTitle") : t("formNewTitle");
  $("formError").hidden = true;

  const defaults = toLocalParts(roundedNow());
  $("fTitle").value = form?.title || prefill?.title || "";
  $("fDate").value = form ? form.startLocal.slice(0, 10) : defaults.date;
  $("fTime").value = form ? form.startLocal.slice(11, 16) : defaults.time;
  const duration = String(form?.durationMin || 60);
  if (![...$("fDuration").options].some(o => o.value === duration)) {
    $("fDuration").append(el("option", { value: duration, text: `${duration} min` }));
  }
  $("fDuration").value = duration;
  fillTimezones(form?.tzid || Intl.DateTimeFormat().resolvedOptions().timeZone);
  fillCalendars(form?.calendarId);
  $("fCalendar").disabled = !!event;
  $("fNotes").value = form?.notes || "";
  state.attendees = [...(form?.attendees || prefill?.attendees || [])];
  renderChips();

  const recurrence = form?.recurrence || defaultModel();
  $("fFreq").value = recurrence.freq;
  $("fInterval").value = recurrence.interval;
  fillWeekdays(recurrence.byDay.length ? recurrence.byDay : [WEEKDAYS[new Date(`${$("fDate").value}T12:00`).getDay()]]);
  for (const radio of document.querySelectorAll("input[name=fEnd]")) radio.checked = radio.value === recurrence.endType;
  $("fCount").value = recurrence.count;
  $("fUntil").value = recurrence.until;
  updateRecurrenceVisibility();

  $("fZoomSettings").hidden = !!event;
  $("fSend").checked = true;
  $("fSendLabel").textContent = event ? t("sendUpdates") : t("sendInvitations");
  showPane("form");
  $("fTitle").focus();
}

function readForm() {
  const pending = $("fAttendeeInput").value.trim();
  if (pending) {
    for (const part of pending.split(/[,;\s]+/).filter(Boolean)) addAttendee(part);
    $("fAttendeeInput").value = "";
  }
  return {
    calendarId: $("fCalendar").value,
    title: $("fTitle").value,
    notes: $("fNotes").value,
    startLocal: `${$("fDate").value}T${$("fTime").value}`,
    durationMin: Number($("fDuration").value),
    tzid: $("fTimezone").value,
    attendees: state.attendees,
    recurrence: {
      freq: $("fFreq").value,
      interval: Number($("fInterval").value),
      byDay: [...$("fWeekdays").querySelectorAll("input:checked")].map(i => i.value),
      endType: document.querySelector("input[name=fEnd]:checked").value,
      count: Number($("fCount").value),
      until: $("fUntil").value,
      nth: state.editing ? meetings.formFromEvent(state.editing).recurrence.nth : undefined,
    },
    settings: {
      waitingRoom: $("fWaitingRoom").checked,
      joinBeforeHost: $("fJoinBeforeHost").checked,
      muteOnEntry: $("fMute").checked,
    },
    sendInvitations: $("fSend").checked,
  };
}

async function submitForm(e) {
  e.preventDefault();
  $("formError").hidden = true;
  if (!state.zoomConnected) {
    $("formError").textContent = t("errorZoomNotConnected");
    $("formError").hidden = false;
    return;
  }
  const form = readForm();
  const calendar = state.calendars.find(c => c.id === form.calendarId);
  if (form.attendees.length && calendar && !calendar.canSchedule) {
    $("formError").textContent = t("errorCalendarNoIdentity", [calendar.name]);
    $("formError").hidden = false;
    return;
  }
  const saveButton = $("btnFormSave");
  saveButton.textContent = t("saving");
  await guarded(saveButton, async () => {
    try {
      const saved = state.editing
        ? await meetings.updateMeeting(state.editing, form, form.sendInvitations)
        : await meetings.createMeeting(form);
      showBanner(state.editing ? t("savedUpdated") : t("savedCreated"), "ok");
      await loadEvents();
      await selectEvent(saved);
    } catch (err) {
      $("formError").textContent = err.message || String(err);
      $("formError").hidden = false;
      $("formError").scrollIntoView({ block: "center" });
      throw err;
    }
  });
  saveButton.textContent = t("actionSave");
}

// ---- existing events -------------------------------------------------------

async function showExisting() {
  showPane("existing");
  const list = $("existingList");
  list.replaceChildren(el("li", { class: "muted", text: t("loading") }));
  const now = Date.now();
  const events = await messenger.zoomCalendar.listEvents({ zoomOnly: false, rangeStartMs: now, rangeEndMs: now + 90 * 86400000 });
  const calendars = new Map(state.calendars.map(c => [c.id, c]));
  const candidates = events
    .filter(e => !e.zoomId && !e.allDay)
    .filter(e => {
      const c = calendars.get(e.calendarId);
      if (!c || c.readOnly) return false;
      // Only events we organize (or without organizer); never someone else's invitation.
      return !e.organizer || (c.identityEmail && e.organizer.email === c.identityEmail.toLowerCase());
    })
    .sort((a, b) => (a.nextOccurrenceMs || a.startMs) - (b.nextOccurrenceMs || b.startMs));
  list.replaceChildren();
  $("existingEmpty").hidden = candidates.length > 0;
  for (const event of candidates) {
    const button = el("button", { class: "primary", text: t("actionAddZoom") });
    button.addEventListener("click", () =>
      guarded(button, async () => {
        if (!state.zoomConnected) throw new Error(t("errorZoomNotConnected"));
        const updated = await meetings.addZoomToEvent(event, true);
        showBanner(t("savedZoomAdded"), "ok");
        await loadEvents();
        await selectEvent(updated);
      })
    );
    list.append(
      el(
        "li",
        { class: "meeting-item static" },
        el("div", { class: "mi-title", text: event.title || t("untitled") }),
        el("div", { class: "mi-when muted small", text: `${formatWhen(event)} · ${event.calendarName}` }),
        el("div", { class: "muted small", text: t("attendeeCount", [String(event.attendees.length)]) }),
        el("div", { class: "row end" }, button)
      )
    );
  }
}

// ---- wiring ----------------------------------------------------------------

function inviteText(event) {
  return [event.title, formatWhen(event), describeRecurrence(event), "", event.description].filter(x => x !== undefined).join("\n");
}

async function handleHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith("meeting=")) {
    const [calendarId, uid] = hash.slice(8).split("/");
    const event = await messenger.zoomCalendar.getEvent(calendarId, uid);
    if (event) await selectEvent(event);
  } else if (hash.startsWith("new=")) {
    let prefill = null;
    try {
      prefill = JSON.parse(hash.slice(4));
    } catch {}
    openForm(null, prefill);
  }
}

async function init() {
  localize();
  setupAutocomplete();

  for (const tab of document.querySelectorAll(".segmented button")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".segmented button").forEach(b => b.classList.toggle("active", b === tab));
      state.filter = tab.dataset.filter;
      renderList();
    });
  }
  $("btnNew").addEventListener("click", () => openForm());
  $("btnExisting").addEventListener("click", () => guarded($("btnExisting"), showExisting));
  $("btnCalendar").addEventListener("click", () => messenger.zoomCalendar.openCalendarTab());
  $("btnRefresh").addEventListener("click", () => guarded($("btnRefresh"), refresh));
  $("btnSettings").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("btnFormCancel").addEventListener("click", () => (state.selected ? renderDetail(state.selected) : showPane("placeholder")));
  $("form").addEventListener("submit", submitForm);
  $("fFreq").addEventListener("change", updateRecurrenceVisibility);

  $("btnStart").addEventListener("click", () => guarded($("btnStart"), () => meetings.startMeeting(state.selected)));
  $("btnJoin").addEventListener("click", () => guarded($("btnJoin"), () => meetings.joinMeeting(state.selected)));
  $("btnCopy").addEventListener("click", () =>
    guarded($("btnCopy"), async () => {
      await navigator.clipboard.writeText(inviteText(state.selected));
      showBanner(t("copied"), "ok");
    })
  );
  $("btnAddToCalendar").addEventListener("click", () =>
    guarded($("btnAddToCalendar"), async () => {
      const saved = await meetings.addZoomMeetingToCalendar(state.selected.zoomId, $("dCalendarSelect").value);
      showBanner(t("savedAddedToCalendar"), "ok");
      await loadEvents();
      await selectEvent(saved);
    })
  );
  $("btnResend").addEventListener("click", () =>
    guarded($("btnResend"), () => meetings.composeInvitation(state.selected, inviteText(state.selected)))
  );
  $("btnEdit").addEventListener("click", () => openForm(state.selected));
  $("btnCancelMeeting").addEventListener("click", () => ($("cancelConfirm").hidden = false));
  $("btnCancelNo").addEventListener("click", () => ($("cancelConfirm").hidden = true));
  $("btnCancelYes").addEventListener("click", () =>
    guarded($("btnCancelYes"), async () => {
      const cancelled = state.selected;
      await meetings.cancelMeeting(cancelled, $("cancelNotify").checked);
      state.zoomMeetings = state.zoomMeetings.filter(m => m.zoomId !== cancelled.zoomId);
      showBanner(t("savedCancelled"), "ok");
      state.selected = null;
      showPane("placeholder");
      await loadEvents();
    })
  );

  messenger.zoomCalendar.onEventChanged.addListener(() => {
    clearTimeout(init.reloadTimer);
    init.reloadTimer = setTimeout(() => refresh({ fromZoom: false }), 500);
  });
  browser.storage.onChanged.addListener(async changes => {
    if (!changes.zoomAuth) return;
    const wasConnected = state.zoomConnected;
    await renderZoomStatus();
    if (wasConnected !== state.zoomConnected) await refresh();
  });
  window.addEventListener("hashchange", handleHash);

  await refresh();
  await handleHash();
}

async function refresh({ fromZoom = true } = {}) {
  await renderZoomStatus();
  if (fromZoom) await loadZoomMeetings();
  await loadEvents();
  if (state.selected && !$("detail").hidden) {
    const { zoomOnly, uid, calendarId } = state.selected;
    const fresh = zoomOnly
      ? allMeetings().some(e => e.uid === uid) && state.selected
      : await messenger.zoomCalendar.getEvent(calendarId, uid);
    if (fresh) {
      state.selected = fresh;
      renderDetail(fresh);
    } else {
      state.selected = null;
      showPane("placeholder");
    }
  }
}

init().catch(e => showBanner(e.message || String(e)));
