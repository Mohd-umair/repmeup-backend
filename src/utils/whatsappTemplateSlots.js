'use strict';

/**
 * Derive the list of required Cloud-API parameter "slots" from a WhatsAppTemplate.
 *
 * A slot describes a single value that has to be supplied at send time:
 *   - body / header TEXT variables (positional or named)
 *   - header media (IMAGE, VIDEO, DOCUMENT)
 *   - header LOCATION
 *   - URL button variables (one slot per `{{n}}` in a URL button)
 *
 * The slot descriptor is the single source of truth for:
 *   - the editor UI (Step 2 — template-param-form)
 *   - CSV column mapping (Step 3 — csv-column-mapper)
 *   - per-recipient component building at send time
 *
 * Slot key convention (string keys, used in WhatsAppCampaignRecipient.templateParams):
 *
 *   header.text.<n>        header TEXT positional variable (1-based)
 *   header.text.<name>     header TEXT named variable
 *   body.<n>               body positional variable (1-based)
 *   body.<name>            body named variable
 *   button.url.<i>.<n>     URL button (index i, 0-based) positional variable (1-based)
 *
 * NOTE: We deliberately do NOT generate a slot for media headers — those are
 * filled by `campaign.headerMedia` / `campaign.headerLocation`, not per-recipient.
 */

const POSITIONAL_RX = /\{\{\s*(\d+)\s*\}\}/g;
const NAMED_RX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function asString(x) {
  return x == null ? '' : String(x);
}

function uniqueNumbersInOrder(matches) {
  const seen = new Set();
  const out = [];
  for (const n of matches) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function extractPositional(text) {
  if (!text) return [];
  const nums = [];
  let m;
  POSITIONAL_RX.lastIndex = 0;
  while ((m = POSITIONAL_RX.exec(text)) !== null) {
    nums.push(parseInt(m[1], 10));
  }
  return uniqueNumbersInOrder(nums);
}

function extractNamed(text) {
  if (!text) return [];
  const names = [];
  let m;
  NAMED_RX.lastIndex = 0;
  while ((m = NAMED_RX.exec(text)) !== null) {
    if (!/^\d+$/.test(m[1])) names.push(m[1]);
  }
  return uniqueNumbersInOrder(names);
}

function findComponent(components, type) {
  if (!Array.isArray(components)) return null;
  return components.find(c => String(c?.type || '').toUpperCase() === type) || null;
}

function buildExampleMap(namedExamples) {
  const map = {};
  if (!Array.isArray(namedExamples)) return map;
  for (const ex of namedExamples) {
    if (!ex) continue;
    const k = String(ex.param_name || '').trim();
    if (!k) continue;
    map[k.toLowerCase()] = asString(ex.example);
  }
  return map;
}

function pickPositionalExample(examples, idx) {
  // examples shape:
  //   body_text:   [[ex1, ex2, ...]]     (one row of values)
  //   header_text: [ex1, ex2, ...]       (flat array)
  if (!examples) return undefined;
  if (Array.isArray(examples) && examples.length) {
    const first = examples[0];
    if (Array.isArray(first)) return asString(first[idx - 1]);
    return asString(examples[idx - 1]);
  }
  return undefined;
}

/**
 * @param {object} template - lean WhatsAppTemplate document.
 * @returns {object} slot descriptor — see file header.
 */
function deriveTemplateSlots(template) {
  if (!template || typeof template !== 'object') {
    return {
      header: { format: null, requiresMedia: false, textSlots: [] },
      body:   { format: 'POSITIONAL', slots: [] },
      buttons: [],
      isAuth: false,
      isUnsupported: null
    };
  }

  const components = Array.isArray(template.components) ? template.components : [];
  const parameterFormat = template.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL';
  const isAuth = String(template.category || '').toUpperCase() === 'AUTHENTICATION';

  // ── HEADER ──────────────────────────────────────────────────────────────
  const headerComp = findComponent(components, 'HEADER');
  const headerFormat = headerComp?.format ? String(headerComp.format).toUpperCase() : null;
  const requiresMedia = headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT';
  const headerTextSlots = [];

  if (headerFormat === 'TEXT' && headerComp?.text) {
    if (parameterFormat === 'NAMED') {
      const named = extractNamed(headerComp.text);
      const exMap = buildExampleMap(headerComp.example?.header_text_named_params);
      named.forEach((name) => {
        headerTextSlots.push({
          key: `header.text.${name}`,
          name,
          label: name,
          exampleValue: exMap[name.toLowerCase()] || undefined
        });
      });
      // Mixed templates can also have positional placeholders inside header text
      const positional = extractPositional(headerComp.text);
      positional.forEach((n) => {
        headerTextSlots.push({
          key: `header.text.${n}`,
          position: n,
          label: `{{${n}}}`,
          exampleValue: pickPositionalExample(headerComp.example?.header_text, n)
        });
      });
    } else {
      const positional = extractPositional(headerComp.text);
      positional.forEach((n) => {
        headerTextSlots.push({
          key: `header.text.${n}`,
          position: n,
          label: `{{${n}}}`,
          exampleValue: pickPositionalExample(headerComp.example?.header_text, n)
        });
      });
    }
  }

  // ── BODY ────────────────────────────────────────────────────────────────
  const bodyComp = findComponent(components, 'BODY');
  const bodySlots = [];

  if (bodyComp?.text) {
    if (parameterFormat === 'NAMED') {
      const named = extractNamed(bodyComp.text);
      const exMap = buildExampleMap(bodyComp.example?.body_text_named_params);
      named.forEach((name) => {
        bodySlots.push({
          key: `body.${name}`,
          name,
          label: name,
          exampleValue: exMap[name.toLowerCase()] || undefined
        });
      });
      const positional = extractPositional(bodyComp.text);
      positional.forEach((n) => {
        bodySlots.push({
          key: `body.${n}`,
          position: n,
          label: `{{${n}}}`,
          exampleValue: pickPositionalExample(bodyComp.example?.body_text, n)
        });
      });
    } else {
      const positional = extractPositional(bodyComp.text);
      positional.forEach((n) => {
        bodySlots.push({
          key: `body.${n}`,
          position: n,
          label: `{{${n}}}`,
          exampleValue: pickPositionalExample(bodyComp.example?.body_text, n)
        });
      });
    }
  }

  // ── BUTTONS ─────────────────────────────────────────────────────────────
  const buttonsComp = findComponent(components, 'BUTTONS');
  const buttons = [];
  const buttonsArr = Array.isArray(buttonsComp?.buttons) ? buttonsComp.buttons : [];
  let unsupported = null;

  buttonsArr.forEach((btn, i) => {
    const t = String(btn?.type || '').toUpperCase();
    if (t === 'URL' && btn?.url) {
      const positional = extractPositional(btn.url);
      if (positional.length) {
        const urlVars = positional.map((n) => ({
          key: `button.url.${i}.${n}`,
          position: n,
          label: `Button "${btn.text || 'URL'}" {{${n}}}`,
          exampleValue: Array.isArray(btn.example) ? asString(btn.example[n - 1]) : undefined
        }));
        buttons.push({ index: i, sub_type: 'url', urlVars, text: asString(btn.text) });
      }
    } else if (t === 'COPY_CODE') {
      // Some COPY_CODE buttons expose a single variable for the code; treat as one slot.
      const positional = extractPositional(btn?.text || '');
      if (positional.length) {
        const urlVars = positional.map((n) => ({
          key: `button.copy_code.${i}.${n}`,
          position: n,
          label: `Copy code {{${n}}}`,
          exampleValue: Array.isArray(btn.example) ? asString(btn.example[n - 1]) : undefined
        }));
        buttons.push({ index: i, sub_type: 'copy_code', urlVars, text: asString(btn.text) });
      }
    } else if (t === 'FLOW' || t === 'CATALOG') {
      // FLOW / CATALOG buttons that need runtime payload params are out of scope for broadcasts.
      // We don't block the template outright — the editor will surface a warning if
      // such a button is present.
    }
    // QUICK_REPLY / PHONE_NUMBER / OTP have no dynamic params from our side.
  });

  // ── Unsupported templates (no CAROUSEL support yet) ────────────────────
  const hasCarousel = components.some(
    c => String(c?.type || '').toUpperCase() === 'CAROUSEL'
  );
  if (hasCarousel) {
    unsupported = { reason: 'Carousel templates are not supported for broadcasts yet.' };
  }

  return {
    header: {
      format: headerFormat,
      requiresMedia,
      textSlots: headerTextSlots
    },
    body: {
      format: parameterFormat,
      slots: bodySlots
    },
    buttons,
    isAuth,
    isUnsupported: unsupported
  };
}

/**
 * Return a flat list of all slot keys (excluding media / location).
 * Used by mapping validators.
 */
function flattenSlotKeys(slots) {
  if (!slots) return [];
  const out = [];
  for (const s of slots.header?.textSlots || []) out.push(s.key);
  for (const s of slots.body?.slots || []) out.push(s.key);
  for (const b of slots.buttons || []) {
    for (const v of b.urlVars || []) out.push(v.key);
  }
  return out;
}

module.exports = {
  deriveTemplateSlots,
  flattenSlotKeys
};
