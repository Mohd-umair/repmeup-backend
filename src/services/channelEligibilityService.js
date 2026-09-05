'use strict';

const Interaction = require('../models/Interaction');

const SESSION_MS = 24 * 60 * 60 * 1000;

function hasChannel(contact, platform) {
  return (contact.channels || []).some((c) => c.platform === platform && c.platformUserId);
}

function channelIdentity(contact, platform) {
  return (contact.channels || []).find((c) => c.platform === platform && c.platformUserId) || null;
}

function preferenceAllowed(contact, platform) {
  const prefs = contact.communicationPreferences || {};
  if (prefs.doNotContact === true) return false;
  // Only an explicit opt-out blocks send. Missing consent on legacy contacts
  // is treated as allowed — they already message the business inbound.
  if (prefs.marketingConsent === false) return false;
  if (platform === 'whatsapp' && prefs.whatsapp === false) return false;
  if (platform === 'instagram' && prefs.instagram === false) return false;
  if (platform === 'facebook' && prefs.facebook === false) return false;
  if (contact.flowsOptedOut && platform === 'whatsapp') return false;
  return true;
}

function evaluateContact(contact, channel, { inSession = false } = {}) {
  if (!hasChannel(contact, channel)) {
    return { eligible: false, reason: `No ${channel} identity` };
  }
  if (!preferenceAllowed(contact, channel)) {
    return { eligible: false, reason: 'Opted out or Do Not Contact' };
  }
  if ((channel === 'instagram' || channel === 'facebook') && !inSession) {
    return { eligible: false, reason: 'No active 24-hour conversation' };
  }
  return { eligible: true, reason: null, platformUserId: channelIdentity(contact, channel).platformUserId };
}

async function sessionMap(orgId, contactIds, channel) {
  if (!contactIds.length) return new Set();
  const since = new Date(Date.now() - SESSION_MS);
  const ids = await Interaction.distinct('contact', {
    organization: orgId,
    contact: { $in: contactIds },
    platform: channel,
    type: 'dm',
    $or: [
      { platformCreatedAt: { $gte: since } },
      { 'metadata.incomingMessages.timestamp': { $gte: since } }
    ]
  });
  return new Set(ids.map(String));
}

async function evaluateMany(orgId, contacts, channel) {
  const ids = contacts.map((c) => c._id);
  const inSession = (channel === 'instagram' || channel === 'facebook')
    ? await sessionMap(orgId, ids, channel)
    : null;

  let eligible = 0;
  let ineligible = 0;
  const results = contacts.map((contact) => {
    const result = evaluateContact(contact, channel, {
      inSession: inSession ? inSession.has(String(contact._id)) : true
    });
    if (result.eligible) eligible += 1;
    else ineligible += 1;
    return { contactId: contact._id, ...result };
  });
  return { eligible, ineligible, results };
}

module.exports = { evaluateContact, evaluateMany, hasChannel, channelIdentity, preferenceAllowed, sessionMap };
