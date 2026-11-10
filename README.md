# Zoom Meetings for Thunderbird

Organize Zoom meetings without leaving Thunderbird. The extension creates the
Zoom meeting and a native Thunderbird calendar event at the same time, and sends
standard iCalendar/iTIP invitations through Thunderbird's own scheduling engine,
so attendees can answer from Outlook, Microsoft 365, Google Calendar or any
other calendar client. Attendees do not need the extension or a Zoom account.

> Status: **beta**. Tested end to end on Thunderbird 157 (release): Zoom connection,
> meeting creation, invitations, replies, updates, recurrence and cancellation.
> Version 0.2.0 was also tested across two computers sharing a Zoom account on
> Thunderbird 159: listing every meeting and adding it to the calendar.
> Version 0.3.0 was tested the same way: invitees restored from Zoom and the
> resend invitation message with `.ics` and `.vcs` attachments.
> Interoperability with every Outlook flavor (classic, new, web) should still be
> checked in your own environment.

## Features

- Connect a Zoom account (OAuth 2.0 with PKCE, no server of our own).
- Create Zoom meetings that are stored as native events in any writable
  Thunderbird calendar (local, CalDAV, Google, Microsoft 365...).
- Pick attendees from the address book (autocomplete).
- Send Outlook-compatible invitations, updates and cancellations (iTIP
  `REQUEST` / `CANCEL`, persistent `UID`, `SEQUENCE` bumps).
- Track responses: incoming iTIP `REPLY` mails are applied automatically to the
  attendee list (accepted, tentative, pending, declined) and shown in a dashboard.
- Modify date, time, recurrence or attendees; changes are pushed to Zoom and to
  the attendees. Moving the event in Thunderbird's own dialog also updates Zoom.
- Recurring meetings (daily, weekly, monthly) mapped to both `RRULE` and Zoom
  recurrence.
- Cancel a meeting: deletes it in Zoom and notifies every attendee.
- Resend the invitation with your own text: opens a new message to every
  attendee with the invitation attached as `.ics` (iCalendar) and `.vcs`
  (vCalendar 1.0, for older clients). You write the text and send it.
- Start as host or join Zoom directly from Thunderbird.
- Add a Zoom meeting to an existing calendar event.
- From any email: open the meeting it refers to, or start a new meeting with the
  people in that thread.
- See every meeting of your Zoom account on every computer, wherever it was
  created, and add the ones you are missing to a calendar with one click.
- Sync events and attendees across devices by creating meetings in a shared
  calendar (CalDAV, Google, Microsoft 365).
- English and Spanish UI.

## Install

1. Download or build `zoom-meetings.xpi` (see [Build](#build)).
2. In Thunderbird: **Tools > Add-ons and Themes**, gear icon > **Install Add-on
   From File...** and pick the `.xpi`.
3. Accept the permissions. The add-on uses an Experiment API (see
   [Architecture](#architecture)), so Thunderbird asks for full access.
4. Create your Zoom app and connect it: follow
   [docs/zoom-app-setup.md](docs/zoom-app-setup.md).

Thunderbird does not require signed add-ons, so the unsigned `.xpi` installs as
is. To publish on addons.thunderbird.net it has to go through ATN review.

### Calendar requirements

Invitations are sent from the email identity of the calendar. In Thunderbird,
open the calendar properties and set **Email** to one of your identities. The
extension settings page lists every calendar and whether it can send
invitations.

## Usage

- **Toolbar button "Zoom"** (mail, calendar and tasks spaces): opens the meeting
  manager tab with upcoming and past meetings, attendee status and actions.
  If you cannot see it, right-click the toolbar > **Customize...** and drag it in.
- **"Zoom meeting" button in the message header**: opens the meeting the email
  belongs to, or prefills a new meeting with the subject and participants.
- Replies are processed when they arrive; a notification shows who answered.

## Architecture

```
api/zoomCalendar/      Experiment API (privileged): native calendar + iTIP
  schema.json
  implementation.js    calICalendar add/modify/delete, cal.itip.checkAndSend,
                       iTIP REPLY parsing, calendar observer
lib/zoom.js            OAuth 2.0 + PKCE (browser.identity), Zoom REST client
lib/recurrence.js      Recurrence model <-> RRULE <-> Zoom recurrence
lib/zoomEvents.js      Zoom meetings -> event model, merge with the calendar
lib/invitation.js      .ics clean-up and .vcs (vCalendar 1.0) generation
lib/meetings.js        Orchestration: Zoom + calendar + mail integration
background.js          Toolbar buttons, new-mail reply processing,
                       calendar-to-Zoom sync, Origin header stripping
ui/                    Meeting manager tab
options/               Settings: Zoom credentials, connection, calendars
_locales/              en, es
```

Why an Experiment API: as of Thunderbird 157 there is no complete WebExtension
calendar API. The extension uses Thunderbird's own calendar (no second calendar,
no duplicated events) and its own iTIP sender, which maximizes the chance that
Outlook processes the invitations correctly.

Zoom metadata is stored on the event as `X-ZOOM-MEETING-ID`, `X-ZOOM-JOIN-URL`
and `X-ZOOM-PASSWORD`. The join link also goes into `LOCATION` and
`DESCRIPTION`, so it is visible in every client.

## Build

```sh
./scripts/build.sh        # -> dist/zoom-meetings.xpi
npm test                  # unit tests (Node 18+)
```

No dependencies or bundler: the source tree is the add-on.

## Known limitations

- Zoom has no readable invitee list, so the extension keeps the invitees at the
  end of the Zoom meeting agenda (`--- Invitees ---`, visible in Zoom). "Add to
  calendar" on another computer restores them, but not their replies, and only
  for meetings created or edited with version 0.3.0 or later. Use a shared
  calendar if you need replies on every computer.
- Changes made to a meeting in Zoom do not update a calendar event that already
  exists.
- Recurring meetings without a fixed time are listed but cannot be added to a
  calendar.
- Recurring meetings are edited as a whole series. Changing or cancelling a
  single occurrence is not supported yet.
- Zoom limits recurring meetings to 60 occurrences and to intervals of up to 15
  days, 12 weeks or 3 months.
- Deleting a meeting from Thunderbird's native dialog does not delete the Zoom
  meeting (on purpose, so that a sync from another device can never delete real
  meetings). Use **Cancel meeting** in the manager tab.
- The native "New Event" dialog has no Zoom button yet. Use the manager tab, or
  **Add Zoom to an event** afterwards.

## Privacy

The extension only talks to `zoom.us` and `api.zoom.us`. OAuth tokens and the
optional client secret are stored in the Thunderbird profile
(`browser.storage.local`). Mail is read locally, only to find iCalendar parts
of meeting replies.

## License

[Mozilla Public License 2.0](LICENSE).
