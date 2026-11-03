// Zoom OAuth 2.0 (authorization code + PKCE) and REST API client.

const AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";
const API_BASE = "https://api.zoom.us/v2";
const STORAGE_KEY = "zoomAuth";

export class ZoomError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export async function getConfig() {
  const { zoomConfig } = await browser.storage.local.get("zoomConfig");
  return zoomConfig || { clientId: "", clientSecret: "" };
}

export async function saveConfig(config) {
  await browser.storage.local.set({ zoomConfig: config });
}

async function getAuth() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || null;
}

async function setAuth(auth) {
  if (auth) {
    await browser.storage.local.set({ [STORAGE_KEY]: auth });
  } else {
    await browser.storage.local.remove(STORAGE_KEY);
  }
}

export function getRedirectUrl() {
  return browser.identity.getRedirectURL();
}

async function tokenRequest(params, config) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams(params);
  if (config.clientSecret) {
    headers.Authorization = "Basic " + btoa(`${config.clientId}:${config.clientSecret}`);
  } else {
    body.set("client_id", config.clientId);
  }
  const response = await fetch(TOKEN_URL, { method: "POST", headers, body });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ZoomError(json.reason || json.error_description || json.error || `Token request failed (${response.status})`, response.status, json.error);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000 - 60_000,
    scope: json.scope || "",
  };
}

export async function connect() {
  const config = await getConfig();
  if (!config.clientId) {
    throw new ZoomError("Missing Zoom client ID. Configure it in the extension options.");
  }
  const redirectUri = getRedirectUrl();
  const verifier = randomString(64);
  const state = randomString(24);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const resultUrl = new URL(await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
  if (resultUrl.searchParams.get("state") !== state) {
    throw new ZoomError("OAuth state mismatch.");
  }
  const code = resultUrl.searchParams.get("code");
  if (!code) {
    throw new ZoomError(resultUrl.searchParams.get("error") || "Zoom did not return an authorization code.");
  }
  const auth = await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier },
    config
  );
  const missing = missingScopes(auth.scope);
  if (missing.length) {
    throw new ZoomError(
      `Your Zoom app is missing these scopes: ${missing.join(", ")}. Add them in Zoom Marketplace > your app > Scopes, then connect again.`
    );
  }
  await setAuth(auth);
  // The profile is only used to show who is connected; user:read:user is optional.
  try {
    const user = await api("GET", "/users/me");
    auth.user = { id: user.id, email: user.email, name: `${user.first_name || ""} ${user.last_name || ""}`.trim(), timezone: user.timezone };
  } catch (e) {
    console.warn("Zoom Meetings: cannot read Zoom profile (user:read:user scope missing?)", e);
    auth.user = null;
  }
  await setAuth(auth);
  return auth.user;
}

// Each capability accepts granular scopes or the classic ones, user or admin level.
const REQUIRED_SCOPES = {
  "meeting:write:meeting": ["meeting:write:meeting", "meeting:write:meeting:admin", "meeting:write", "meeting:write:admin"],
  "meeting:update:meeting": ["meeting:update:meeting", "meeting:update:meeting:admin", "meeting:write", "meeting:write:admin"],
  "meeting:delete:meeting": ["meeting:delete:meeting", "meeting:delete:meeting:admin", "meeting:write", "meeting:write:admin"],
  "meeting:read:meeting": ["meeting:read:meeting", "meeting:read:meeting:admin", "meeting:read", "meeting:read:admin"],
};

export function missingScopes(scopeString) {
  if (!scopeString) {
    return [];
  }
  const granted = new Set(scopeString.split(/[\s,]+/).filter(Boolean));
  return Object.entries(REQUIRED_SCOPES)
    .filter(([, accepted]) => !accepted.some(s => granted.has(s)))
    .map(([name]) => name);
}

export async function disconnect() {
  await setAuth(null);
}

export async function status() {
  const auth = await getAuth();
  return auth ? { connected: true, user: auth.user || null } : { connected: false };
}

let refreshing = null;

async function accessToken() {
  const auth = await getAuth();
  if (!auth) {
    throw new ZoomError("Zoom account not connected.", 401, "not_connected");
  }
  if (Date.now() < auth.expiresAt) {
    return auth.accessToken;
  }
  // Single in-flight refresh: Zoom rotates refresh tokens.
  refreshing ??= (async () => {
    try {
      const config = await getConfig();
      const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken }, config);
      await setAuth({ ...auth, ...fresh });
      return fresh.accessToken;
    } catch (e) {
      if (e.status === 400 || e.status === 401) {
        await setAuth(null);
        throw new ZoomError("Zoom session expired. Connect your account again.", 401, "not_connected");
      }
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api(method, path, body) {
  const token = await accessToken();
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    const detail = json.message || text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    console.error(`Zoom API ${method} ${path} -> ${response.status}`, { code: json.code, body: text.slice(0, 2000), sent: body });
    throw new ZoomError(
      `Zoom API error ${response.status}${json.code ? ` (code ${json.code})` : ""} on ${method} ${path}${detail ? `: ${detail}` : ""}`,
      response.status,
      json.code
    );
  }
  return json;
}

/**
 * Builds the Zoom meeting payload from the extension meeting model.
 * meeting: { title, startLocal, durationMin, tzid, description, recurrence, settings }
 */
export function toZoomPayload(meeting, zoomRecurrence) {
  const payload = {
    topic: meeting.title,
    agenda: (meeting.agenda || "").slice(0, 2000),
    start_time: `${meeting.startLocal}:00`,
    duration: meeting.durationMin,
    timezone: meeting.tzid,
    type: zoomRecurrence ? 8 : 2,
    settings: {
      waiting_room: !!meeting.settings?.waitingRoom,
      join_before_host: !!meeting.settings?.joinBeforeHost,
      mute_upon_entry: !!meeting.settings?.muteOnEntry,
      host_video: true,
      participant_video: true,
    },
  };
  if (zoomRecurrence) {
    payload.recurrence = zoomRecurrence;
  }
  return payload;
}

export async function createMeeting(meeting, zoomRecurrence) {
  return api("POST", "/users/me/meetings", toZoomPayload(meeting, zoomRecurrence));
}

export async function updateMeeting(id, meeting, zoomRecurrence) {
  const payload = toZoomPayload(meeting, zoomRecurrence);
  if (!zoomRecurrence) {
    delete payload.recurrence;
  }
  await api("PATCH", `/meetings/${encodeURIComponent(id)}`, payload);
}

export async function deleteMeeting(id) {
  try {
    await api("DELETE", `/meetings/${encodeURIComponent(id)}?schedule_for_reminder=false`);
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
  }
}

export async function getMeeting(id) {
  return api("GET", `/meetings/${encodeURIComponent(id)}`);
}
