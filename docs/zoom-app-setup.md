# Creating the Zoom app (Client ID)

The extension talks to Zoom on your behalf through OAuth 2.0 with PKCE. Zoom
requires every integration to be registered as an "app", so you need to create
one (once) in the Zoom App Marketplace and paste its **Client ID** into the
extension settings. Nothing is hosted by the extension author: the app lives in
your own Zoom account and the tokens stay in your Thunderbird profile.

Time needed: about 5 minutes.

## Before you start

- A Zoom account (a free Basic account is enough to create scheduled meetings).
- The extension installed in Thunderbird, so you can copy its **Redirect URL**:
  open the add-on settings (Add-ons and Themes > Zoom Meetings > Preferences).
  The URL looks like `https://<40 hex chars>.extensions.allizom.org/`. It is
  derived from the add-on ID, so it is the same on every machine for the same
  build.

## 1. Create a General App

1. Sign in at <https://marketplace.zoom.us/> with your Zoom account.
2. Click **Develop** (top right) > **Build App**.
3. Choose **General App** and click **Create**.
4. Give it a name, for example `Thunderbird Zoom Meetings`.

## 2. Basic Information

1. Under **Select how the app is managed**, choose **User-managed**.
   An admin-managed app cannot create meetings through `users/me`.
2. If the page offers a **Public client** / PKCE option, enable it. Then the
   extension needs no client secret. If your app is a confidential client, you
   can still use it: paste the client secret in the extension settings as well
   (it is stored only in your Thunderbird profile).
3. In **OAuth Information**:
   - **OAuth Redirect URL**: paste the Redirect URL shown in the extension settings.
   - **OAuth Allow List**: add the same URL again.

   Both must match exactly, including the trailing `/`.
4. Copy the **Client ID** from **App Credentials**. The development credentials
   are fine for personal use (see "Development vs production" below).

## 3. Scopes

Open **Scopes** > **Add Scopes** and add:

| Scope | Why |
| --- | --- |
| `meeting:write:meeting` | Create meetings |
| `meeting:update:meeting` | Change date, time, title or recurrence |
| `meeting:delete:meeting` | Cancel meetings |
| `meeting:read:meeting` | Get the host start link ("Start as host") |
| `user:read:user` | Optional. Shows which Zoom user is connected |

The extension checks the granted scopes when you connect and tells you which
ones are missing.

## 4. Connect from Thunderbird

1. In the extension settings, paste the **Client ID** (and the client secret only
   if your app is not a public client) and click **Save**.
2. Click **Connect Zoom**, sign in to Zoom and click **Allow**.
3. The settings page shows `Zoom connected: <your email>`.

If you change scopes later, click **Disconnect** and **Connect Zoom** again:
Zoom only grants new scopes on a fresh authorization.

## Development vs production

- **Development credentials** work for users of the Zoom account that owns the
  app. That covers using the extension yourself, or within your own company
  account.
- To let users from other Zoom accounts connect with your Client ID, the app
  must go through Zoom's publishing/review process. Alternatively, each user can
  create their own app by following this guide.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Invalid redirect` or error 4700 in the Zoom window | The Redirect URL or the Allow List entry does not match the URL shown in the extension settings. Paste it again, including the trailing `/`. |
| `Invalid access token, does not contain scopes: [...]` | The listed scope is missing. Add it under **Scopes**, then disconnect and connect again. |
| `Your Zoom app is missing these scopes: ...` | Same as above, detected by the extension at connection time. |
| `403 ... Invalid CORS request` | Zoom rejects requests that carry a browser `Origin` header. Versions 0.1.4 and later strip it. Update the extension. |
| The Zoom login window stays open | Finish the login and click **Allow**. The console messages from Zoom's own page (`auth.js`, `UnifyWebView`) are harmless. |
| `Zoom session expired` | The refresh token expired or was revoked (Zoom refresh tokens last 90 days). Connect again. |
