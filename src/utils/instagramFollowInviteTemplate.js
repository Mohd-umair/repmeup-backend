'use strict';

/**
 * Instagram Generic Template payloads for "follow invite" private replies.
 * Caps follow Meta limits (title/subtitle/button title).
 */

const MAX_TITLE = 80;
const MAX_SUBTITLE = 80;
const MAX_BUTTON_TITLE = 20;

/**
 * @param {string} username - Instagram handle without @
 * @returns {string|null} https profile URL or null
 */
function normalizeHttpsProfileUrl(username) {
  const u = String(username || '')
    .replace(/^@/, '')
    .trim();
  if (!u) return null;
  return `https://www.instagram.com/${u}/`;
}

/**
 * @param {object} p
 * @param {string} p.title
 * @param {string} [p.subtitle]
 * @param {string} [p.imageUrl] - optional, must be https if set
 * @param {string} p.buttonTitle
 * @param {string} p.buttonUrl - https
 * @returns {object} Single generic template element
 */
function buildFollowInviteGenericElement(p) {
  const title = String(p.title || 'Thanks!').trim().slice(0, MAX_TITLE);
  const subtitle = String(p.subtitle || '').trim().slice(0, MAX_SUBTITLE);
  const buttonTitle = String(p.buttonTitle || 'Follow').trim().slice(0, MAX_BUTTON_TITLE);
  const buttonUrl = String(p.buttonUrl || '').trim();
  if (!/^https:\/\//i.test(buttonUrl)) {
    throw new Error('Follow button URL must start with https://');
  }
  const element = {
    title,
    buttons: [{ type: 'web_url', url: buttonUrl, title: buttonTitle }]
  };
  if (subtitle) element.subtitle = subtitle;
  const imageUrl = String(p.imageUrl || '').trim();
  if (imageUrl && /^https:\/\//i.test(imageUrl)) {
    element.image_url = imageUrl;
  }
  return element;
}

module.exports = {
  buildFollowInviteGenericElement,
  normalizeHttpsProfileUrl,
  MAX_TITLE,
  MAX_SUBTITLE,
  MAX_BUTTON_TITLE
};
