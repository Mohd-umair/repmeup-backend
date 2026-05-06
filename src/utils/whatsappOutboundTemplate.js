/**
 * Sanitize WhatsApp Cloud API template payload for outbound sends (inbox reply).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#template-messages
 */

function sanitizeTextParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'text') return null;
  const text = String(p.text ?? '').trim().slice(0, 4096);
  if (!text) return null;
  const out = { type: 'text', text };
  const pn = p.parameter_name;
  if (pn && String(pn).trim()) {
    out.parameter_name = String(pn).trim().slice(0, 256);
  }
  return out;
}

function sanitizeImageParameter(p) {
  if (!p || String(p.type || '').toLowerCase() !== 'image') return null;
  const link = p.image?.link || p.image?.url;
  if (!link || typeof link !== 'string') return null;
  return { type: 'image', image: { link: link.trim().slice(0, 2048) } };
}

function sanitizeParameters(parameters) {
  if (!Array.isArray(parameters)) return [];
  const out = [];
  for (const p of parameters) {
    const t = String(p?.type || '').toLowerCase();
    if (t === 'text') {
      const x = sanitizeTextParameter(p);
      if (x) out.push(x);
    } else if (t === 'image') {
      const x = sanitizeImageParameter(p);
      if (x) out.push(x);
    }
  }
  return out;
}

function sanitizeComponents(components) {
  if (!Array.isArray(components)) return [];
  const allowed = new Set(['header', 'body']);
  const out = [];
  for (const c of components) {
    const type = String(c?.type || '').toLowerCase();
    if (!allowed.has(type)) continue;
    const parameters = sanitizeParameters(c.parameters);
    if (!parameters.length) continue;
    out.push({ type, parameters });
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
