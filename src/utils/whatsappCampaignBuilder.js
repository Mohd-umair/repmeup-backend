'use strict';

/**
 * Build the per-recipient Meta Cloud-API `components` array for a campaign send.
 *
 * Inputs:
 *   - template:  WhatsAppTemplate lean doc (uppercase Meta shape)
 *   - campaign:  WhatsAppCampaign lean/full doc — supplies headerMedia, headerLocation, urlButtonParams
 *   - recipient: WhatsAppCampaignRecipient lean doc — supplies templateParams (text vars)
 *
 * Output:  components array ready to send to Cloud API.  e.g.
 *
 *   [
 *     { type: 'header', parameters: [{ type: 'image', image: { link } }] },
 *     { type: 'body',   parameters: [{ type: 'text', text: 'Alice' }, ...] },
 *     { type: 'button', sub_type: 'url', index: '0',
 *       parameters: [{ type: 'text', text: 'TRK99' }] }
 *   ]
 *
 * Single source of truth for slot-key → component-position mapping; mirrors
 * the slot identifiers produced by `whatsappTemplateSlots.deriveTemplateSlots`.
 */

const { deriveTemplateSlots } = require('./whatsappTemplateSlots');

function asString(x) {
  return x == null ? '' : String(x);
}

function trimText(v, max = 1024) {
  return asString(v).slice(0, max);
}

function getParam(params, key, fallback) {
  if (params && Object.prototype.hasOwnProperty.call(params, key) && params[key] != null) {
    return asString(params[key]);
  }
  if (fallback != null) return asString(fallback);
  return '';
}

/**
 * Build header `parameters` array based on the template's HEADER format.
 */
function buildHeaderParameters({ slots, campaign, recipientParams }) {
  const header = slots.header || {};
  const format = header.format;

  if (!format || format === 'TEXT') {
    if (!header.textSlots?.length) return [];
    // Two cases: positional (text:[txt,txt]) or named (text + parameter_name)
    return header.textSlots.map((slot) => {
      const value = getParam(recipientParams, slot.key, slot.exampleValue);
      const p = { type: 'text', text: trimText(value, 60) };
      if (slot.name) p.parameter_name = String(slot.name).slice(0, 256);
      return p;
    });
  }

  if (format === 'IMAGE') {
    const link = asString(campaign?.headerMedia?.url || '').trim();
    if (!link) return [];
    return [{ type: 'image', image: { link } }];
  }

  if (format === 'VIDEO') {
    const link = asString(campaign?.headerMedia?.url || '').trim();
    if (!link) return [];
    return [{ type: 'video', video: { link } }];
  }

  if (format === 'DOCUMENT') {
    const link = asString(campaign?.headerMedia?.url || '').trim();
    if (!link) return [];
    const document = { link };
    const fn = asString(campaign?.headerMedia?.filename || '').trim();
    if (fn) document.filename = fn.slice(0, 240);
    return [{ type: 'document', document }];
  }

  if (format === 'LOCATION') {
    const loc = campaign?.headerLocation || {};
    if (loc.latitude == null || loc.longitude == null) return [];
    const out = {
      type: 'location',
      location: {
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude)
      }
    };
    if (loc.name) out.location.name = asString(loc.name).slice(0, 200);
    if (loc.address) out.location.address = asString(loc.address).slice(0, 500);
    return [out];
  }

  return [];
}

/**
 * Build body `parameters` array — one text param per body slot in order.
 */
function buildBodyParameters({ slots, recipientParams }) {
  const list = slots.body?.slots || [];
  if (!list.length) return [];
  return list.map((slot) => {
    const value = getParam(recipientParams, slot.key, slot.exampleValue);
    const p = { type: 'text', text: trimText(value, 1024) };
    if (slot.name) p.parameter_name = String(slot.name).slice(0, 256);
    return p;
  });
}

/**
 * Build the button components.  One component per parameterised button.
 * Returns `[]` if no buttons need params.
 */
function buildButtonComponents({ slots, campaign, recipientParams }) {
  const buttonSlots = slots.buttons || [];
  if (!buttonSlots.length) return [];

  // Index by-index lookup of campaign-level overrides for URL buttons
  const urlOverrides = new Map();
  for (const p of campaign?.urlButtonParams || []) {
    if (p && typeof p.index === 'number') {
      urlOverrides.set(p.index, asString(p.value));
    }
  }

  const out = [];
  for (const btn of buttonSlots) {
    if (!btn.urlVars?.length) continue;
    const subType = btn.sub_type || 'url';
    const parameters = btn.urlVars.map((slot) => {
      const v =
        getParam(recipientParams, slot.key) ||
        urlOverrides.get(btn.index) ||
        asString(slot.exampleValue);
      return { type: 'text', text: trimText(v, 256) };
    });
    out.push({
      type: 'button',
      sub_type: subType,
      index: String(btn.index),
      parameters
    });
  }
  return out;
}

/**
 * @param {object} template - lean WhatsAppTemplate document
 * @param {object} campaign - WhatsAppCampaign (lean/full) — used for media/location/url-button overrides
 * @param {object} recipient - WhatsAppCampaignRecipient { templateParams }
 * @returns {Array} components array ready to send to Cloud API
 */
function buildRecipientComponents(template, campaign, recipient) {
  if (!template) return [];
  const slots = deriveTemplateSlots(template);
  const recipientParams = recipient?.templateParams || {};

  const headerParams = buildHeaderParameters({ slots, campaign, recipientParams });
  const bodyParams = buildBodyParameters({ slots, recipientParams });
  const buttonComps = buildButtonComponents({ slots, campaign, recipientParams });

  const out = [];
  if (headerParams.length) out.push({ type: 'header', parameters: headerParams });
  if (bodyParams.length) out.push({ type: 'body', parameters: bodyParams });
  for (const b of buttonComps) out.push(b);

  return out;
}

/**
 * Validate that the campaign has everything it needs to launch given the template.
 *  - Returns null on success; throws Error with statusCode 400 on validation failure.
 */
function assertCampaignReadyForTemplate(template, campaign) {
  if (!template) {
    const err = new Error('Template not found for this campaign.');
    err.statusCode = 400;
    throw err;
  }
  const slots = deriveTemplateSlots(template);

  if (slots.isAuth) {
    const err = new Error('Authentication / OTP templates cannot be used for broadcasts.');
    err.statusCode = 400;
    throw err;
  }
  if (slots.isUnsupported) {
    const err = new Error(slots.isUnsupported.reason);
    err.statusCode = 400;
    throw err;
  }

  // Media headers must have a URL on the campaign
  if (slots.header.requiresMedia) {
    const url = asString(campaign?.headerMedia?.url || '').trim();
    if (!url) {
      const err = new Error(
        `This template requires a ${slots.header.format} header — please upload media.`
      );
      err.statusCode = 400;
      throw err;
    }
    if (campaign?.headerMedia?.kind && campaign.headerMedia.kind !== slots.header.format) {
      const err = new Error(
        `Header media type mismatch: expected ${slots.header.format}, got ${campaign.headerMedia.kind}.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  // Location header must be complete
  if (slots.header.format === 'LOCATION') {
    const loc = campaign?.headerLocation || {};
    if (loc.latitude == null || loc.longitude == null) {
      const err = new Error('This template requires a location header (latitude & longitude).');
      err.statusCode = 400;
      throw err;
    }
  }

  return slots;
}

module.exports = {
  buildRecipientComponents,
  assertCampaignReadyForTemplate
};
