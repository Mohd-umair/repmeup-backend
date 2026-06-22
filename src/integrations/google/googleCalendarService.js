'use strict';

/**
 * Google Calendar 2-way sync for providers.
 *
 *  • Outbound: when an appointment is booked / changed / cancelled we create,
 *    patch or delete the matching event on the provider's Google Calendar
 *    (appointment.googleEventId links the two).
 *  • Inbound: availabilityService calls freeBusy() so externally-created Google
 *    events block our bookable slots — keeping a provider's two calendars in sync.
 *
 * Reuses the googleapis OAuth2 client (same app credentials as googleAuthService),
 * with the Calendar scope and per-provider stored tokens (auto-refreshed).
 *
 * Function names pushEvent / updateEvent / deleteEvent / freeBusy match the hook
 * points in appointmentService + availabilityService.
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const logger = require('../../config/logger');

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];

function redirectUri() {
  return process.env.GOOGLE_CALENDAR_REDIRECT_URI
    || `${process.env.BASE_URL || 'http://localhost:3000'}/api/appointments/providers/google/callback`;
}

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

// ── OAuth (per provider) ─────────────────────────────────────────────────────

function getConnectUrl(organizationId, providerId) {
  const state = Buffer.from(JSON.stringify({
    organizationId: String(organizationId),
    providerId: String(providerId),
    nonce: crypto.randomBytes(8).toString('hex'),
    ts: Date.now()
  })).toString('base64');

  return newOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // ensure a refresh_token
    scope: CALENDAR_SCOPES,
    state
  });
}

function parseState(state) {
  try {
    const d = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    if (!d.organizationId || !d.providerId) throw new Error('missing fields');
    if (Date.now() - d.ts > 15 * 60 * 1000) throw new Error('state expired');
    return d;
  } catch (err) {
    throw new Error(`Invalid Google Calendar state: ${err.message}`);
  }
}

/** Exchange the code and persist tokens onto the provider. */
async function handleCallback(code, state) {
  const { organizationId, providerId } = parseState(state);
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);

  const Provider = require('../../models/Provider');
  const provider = await Provider.findOne({ _id: providerId, organization: organizationId });
  if (!provider) throw new Error('Provider not found');

  provider.google = provider.google || {};
  provider.google.connected = true;
  provider.google.calendarId = provider.google.calendarId || 'primary';
  if (tokens.access_token) provider.google.accessToken = tokens.access_token;
  if (tokens.refresh_token) provider.google.refreshToken = tokens.refresh_token;
  if (tokens.expiry_date) provider.google.tokenExpiry = new Date(tokens.expiry_date);
  provider.markModified('google');
  await provider.save();

  logger.info('[gcal] provider connected', { providerId: String(provider._id) });
  return { providerId: String(provider._id), name: provider.name };
}

async function disconnect(organizationId, providerId) {
  const Provider = require('../../models/Provider');
  await Provider.updateOne(
    { _id: providerId, organization: organizationId },
    { $set: { 'google.connected': false }, $unset: { 'google.accessToken': '', 'google.refreshToken': '', 'google.tokenExpiry': '', 'google.syncToken': '' } }
  );
}

// ── Authorized client (refresh-aware) ────────────────────────────────────────

async function authorizedClient(provider) {
  if (!provider?.google?.refreshToken && !provider?.google?.accessToken) return null;
  const client = newOAuthClient();
  client.setCredentials({
    access_token: provider.google.accessToken,
    refresh_token: provider.google.refreshToken,
    expiry_date: provider.google.tokenExpiry ? new Date(provider.google.tokenExpiry).getTime() : undefined
  });

  // Persist refreshed tokens so we don't re-refresh every call.
  client.on('tokens', async (tokens) => {
    try {
      const Provider = require('../../models/Provider');
      const set = {};
      if (tokens.access_token) set['google.accessToken'] = tokens.access_token;
      if (tokens.refresh_token) set['google.refreshToken'] = tokens.refresh_token;
      if (tokens.expiry_date) set['google.tokenExpiry'] = new Date(tokens.expiry_date);
      if (Object.keys(set).length) {
        await Provider.updateOne({ _id: provider._id }, { $set: set });
      }
    } catch (e) {
      logger.warn('[gcal] token persist failed', { error: e.message });
    }
  });
  return client;
}

function calendarFor(client) {
  return google.calendar({ version: 'v3', auth: client });
}

function eventBody(appointment, provider) {
  const tz = appointment.timezone || provider.timezone || 'Asia/Kolkata';
  const name = appointment.serviceSnapshot?.name || 'Appointment';
  const customer = appointment.customerName || appointment.customerPhone || 'Customer';
  return {
    summary: `${name} — ${customer}`,
    description: `Booked via RepMeUp${appointment.displayRef ? ` (${appointment.displayRef})` : ''}.`
      + (appointment.customerPhone ? `\nPhone: ${appointment.customerPhone}` : ''),
    start: { dateTime: new Date(appointment.startAt).toISOString(), timeZone: tz },
    end: { dateTime: new Date(appointment.endAt).toISOString(), timeZone: tz }
  };
}

// ── Outbound sync (called from appointmentService) ───────────────────────────

async function pushEvent(appointment, provider) {
  if (!provider?.google?.connected) return;
  const client = await authorizedClient(provider);
  if (!client) return;
  const calendar = calendarFor(client);
  const res = await calendar.events.insert({
    calendarId: provider.google.calendarId || 'primary',
    requestBody: eventBody(appointment, provider)
  });
  const eventId = res.data?.id;
  if (eventId) {
    const Appointment = require('../../models/Appointment');
    await Appointment.updateOne({ _id: appointment._id }, { $set: { googleEventId: eventId } });
  }
}

async function updateEvent(appointment, provider) {
  if (!provider?.google?.connected) return;
  if (!appointment.googleEventId) return pushEvent(appointment, provider);
  const client = await authorizedClient(provider);
  if (!client) return;
  await calendarFor(client).events.patch({
    calendarId: provider.google.calendarId || 'primary',
    eventId: appointment.googleEventId,
    requestBody: eventBody(appointment, provider)
  });
}

async function deleteEvent(appointment, provider) {
  if (!provider?.google?.connected || !appointment.googleEventId) return;
  const client = await authorizedClient(provider);
  if (!client) return;
  try {
    await calendarFor(client).events.delete({
      calendarId: provider.google.calendarId || 'primary',
      eventId: appointment.googleEventId
    });
  } catch (err) {
    if (err.code !== 410 && err.code !== 404) throw err; // already gone is fine
  }
}

// ── Inbound sync (called from availabilityService) ───────────────────────────

/**
 * Busy intervals on the provider's Google Calendar in [fromUtc, toUtc].
 * @returns {Promise<Array<{start:number,end:number}>>} ms timestamps
 */
async function freeBusy(provider, fromUtc, toUtc) {
  if (!provider?.google?.connected) return [];
  const client = await authorizedClient(provider);
  if (!client) return [];
  const res = await calendarFor(client).freebusy.query({
    requestBody: {
      timeMin: new Date(fromUtc).toISOString(),
      timeMax: new Date(toUtc).toISOString(),
      items: [{ id: provider.google.calendarId || 'primary' }]
    }
  });
  const cal = res.data?.calendars?.[provider.google.calendarId || 'primary'];
  return (cal?.busy || []).map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }));
}

module.exports = {
  getConnectUrl,
  handleCallback,
  disconnect,
  pushEvent,
  updateEvent,
  deleteEvent,
  freeBusy,
  CALENDAR_SCOPES
};
