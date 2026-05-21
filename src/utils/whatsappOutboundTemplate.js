/**
 * Sanitize WhatsApp Cloud API template payload for outbound sends.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#template-messages
 *
 * Supports the parameter / header / button shapes used by Meta:
 *   header parameters: text, image, video, document, location
 *   body parameters:   text
 *   button components: type=button, sub_type ∈ {url, copy_code, quick_reply, flow}, index, parameters
 */

function clipString(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function sanitizeTextParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'text') return null;
  const text = clipString(p.text, 4096);
  if (!text) return null;
  const out = { type: 'text', text };
  if (p.parameter_name) {
    const pn = clipString(p.parameter_name, 256);
    if (pn) out.parameter_name = pn;
  }
  return out;
}

function sanitizeImageParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'image') return null;
  const link = p.image?.link || p.image?.url;
  if (!link || typeof link !== 'string') return null;
  return { type: 'image', image: { link: clipString(link, 2048) } };
}

function sanitizeVideoParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'video') return null;
  const link = p.video?.link || p.video?.url;
  if (!link || typeof link !== 'string') return null;
  return { type: 'video', video: { link: clipString(link, 2048) } };
}

function sanitizeDocumentParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'document') return null;
  const link = p.document?.link || p.document?.url;
  if (!link || typeof link !== 'string') return null;
  const document = { link: clipString(link, 2048) };
  if (p.document?.filename) {
    const fn = clipString(p.document.filename, 240);
    if (fn) document.filename = fn;
  }
  return { type: 'document', document };
}

function sanitizeLocationParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'location') return null;
  const loc = p.location || {};
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const out = {
    type: 'location',
    location: { latitude: lat, longitude: lng }
  };
  if (loc.name) out.location.name = clipString(loc.name, 200);
  if (loc.address) out.location.address = clipString(loc.address, 500);
  return out;
}

function sanitizeParameters(parameters) {
  if (!Array.isArray(parameters)) return [];
  const out = [];
  for (const p of parameters) {
    const t = String(p?.type || '').toLowerCase();
    let x = null;
    switch (t) {
      case 'text':     x = sanitizeTextParameter(p); break;
      case 'image':    x = sanitizeImageParameter(p); break;
      case 'video':    x = sanitizeVideoParameter(p); break;
      case 'document': x = sanitizeDocumentParameter(p); break;
      case 'location': x = sanitizeLocationParameter(p); break;
      default: x = null;
    }
    if (x) out.push(x);
  }
  return out;
}

const ALLOWED_BUTTON_SUB_TYPES = new Set(['url', 'quick_reply', 'copy_code', 'flow', 'catalog', 'voice_call', 'phone_number']);

function sanitizeButtonComponent(c) {
  const subType = String(c.sub_type || '').toLowerCase();
  if (!ALLOWED_BUTTON_SUB_TYPES.has(subType)) return null;

  const rawIndex = c.index == null ? '0' : String(c.index);
  // Cloud API accepts strings; allow 0..9
  if (!/^[0-9]$/.test(rawIndex)) return null;

  const parameters = sanitizeParameters(c.parameters);
  if (!parameters.length) return null;

  return {
    type: 'button',
    sub_type: subType,
    index: rawIndex,
    parameters
  };
}

function sanitizeComponents(components) {
  if (!Array.isArray(components)) return [];
  const out = [];
  for (const c of components) {
    const type = String(c?.type || '').toLowerCase();
    if (type === 'header' || type === 'body') {
      const parameters = sanitizeParameters(c.parameters);
      if (!parameters.length) continue;
      out.push({ type, parameters });
      continue;
    }
    if (type === 'button') {
      const btn = sanitizeButtonComponent(c);
      if (btn) out.push(btn);
      continue;
    }
    // unknown / footer-only / etc. — skip
  }
  return out;
}

/**
 * @param {object} raw - from client { name, languageCode, components }
 * @returns {object|null} - { name, languageCode, components } or null if invalid
 */
function sanitizeWhatsAppOutboundTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nameIn = String(raw.name || '').trim().toLowerCase();
  if (!nameIn || !/^[a-z0-9_]+$/.test(nameIn)) return null;
  const languageCode = String(raw.languageCode || 'en_US').trim().slice(0, 35) || 'en_US';
  const components = sanitizeComponents(raw.components);
  return { name: nameIn.slice(0, 512), languageCode, components };
}

module.exports = {
  sanitizeWhatsAppOutboundTemplate
};
