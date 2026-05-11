'use strict';

/**
 * Builds a compact recent thread transcript for GENAI reply prompts (auto-reply, assistant).
 * Merges metadata.incomingMessages (customer) with replies[] (business) by timestamp when
 * present (typical for Instagram / WhatsApp / Facebook DMs). Rare missing timestamps fall
 * back to stable role + index ordering.
 *
 * **Voice notes:** Webhooks often store `[audio]` / `[Voice note]` in the thread while
 * `interaction.content` holds the Whisper transcript — the latest customer line is replaced
 * with `interaction.content` when the stored line is still a placeholder, so the model sees
 * real words for both voice and text.
 */

const DEFAULT_MAX_MESSAGES = 5;
const DEFAULT_MAX_LINE_CHARS = 360;
const DEFAULT_MAX_TOTAL_CHARS = 2400;

/**
 * @param {unknown} ts
 * @returns {number|null} Epoch ms or null
 */
function normalizeMsgTimestamp(ts) {
  if (ts == null) return null;
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1e12) return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * @param {object} msg — metadata.incomingMessages element
 * @returns {string}
 */
function incomingBodyLine(msg) {
  const raw = msg.text != null ? String(msg.text).trim() : '';
  if (raw) return raw;
  const at = (msg.attachmentType || msg.type || '').toLowerCase();
  if (at === 'image' || at === 'photo') return '[Photo]';
  if (at === 'video') return '[Video]';
  if (at === 'audio') return '[Voice note]';
  if (at === 'file' || at === 'document') return '[File]';
  if (at === 'sticker') return '[Sticker]';
  if (at === 'location') return '[Location]';
  return '[Message]';
}

function truncateLine(s, max) {
  if (s == null || s === '') return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * True when the inbox row is only a placeholder — real text lives on interaction.content
 * (e.g. voice notes after Whisper transcription).
 */
function isPlaceholderCustomerLine(line) {
  const s = (line || '').trim();
  if (!s) return true;
  if (/^\[(audio|Audio Message|voice|voice note|Voice note|image|video|file|photo|sticker|location|message|attachment|shared instagram reel|shared instagram story|shared instagram post)\]$/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * Use canonical interaction.content for the **most recent** customer turn in the slice when
 * the stored thread line is still a placeholder. Keeps voice + text aligned for GENAI context.
 */
function applyLatestCustomerContent(sliced, interaction, maxLine) {
  const latest = interaction?.content != null ? String(interaction.content).trim() : '';
  if (!latest || !sliced.length) return;
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (sliced[i].role !== 'Customer') continue;
    const cur = (sliced[i].body || '').trim();
    if (latest === cur) return;
    if (isPlaceholderCustomerLine(cur)) {
      sliced[i].body = truncateLine(latest, maxLine);
    }
    return;
  }
}

/**
 * @param {object} interaction — Mongoose doc or plain object
 * @param {object} [opts]
 * @param {number} [opts.maxMessages=5] — max transcript lines (customer + business turns)
 * @param {number} [opts.maxLineChars=360]
 * @param {number} [opts.maxTotalChars=2400]
 * @returns {string} Transcript or '' if no thread data beyond a bare interaction
 */
function buildRecentConversationTranscript(interaction, opts = {}) {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxLine = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const events = [];
  const incoming = interaction?.metadata?.incomingMessages;

  if (Array.isArray(incoming)) {
    incoming.forEach((msg, idx) => {
      const line = truncateLine(incomingBodyLine(msg), maxLine);
      if (!line) return;
      events.push({
        t: normalizeMsgTimestamp(msg.timestamp),
        tie: idx,
        role: 'Customer',
        body: line,
        kind: 'in'
      });
    });
  }

  const replies = Array.isArray(interaction?.replies) ? interaction.replies : [];
  replies.forEach((r, idx) => {
    if (r?.status === 'deleted') return;
    const c = r?.content != null ? String(r.content).trim() : '';
    if (!c) return;
    let t = null;
    if (r.sentAt) {
      const d = r.sentAt instanceof Date ? r.sentAt : new Date(r.sentAt);
      t = Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    events.push({
      t,
      tie: idx,
      role: 'Business',
      body: truncateLine(c, maxLine),
      kind: 'out'
    });
  });

  if (events.length === 0) return '';

  events.sort((a, b) => {
    const ha = a.t != null;
    const hb = b.t != null;
    if (ha && hb && a.t !== b.t) return a.t - b.t;
    if (ha && !hb) return -1;
    if (!ha && hb) return 1;
    if (a.kind !== b.kind) return a.kind === 'in' ? -1 : 1;
    return a.tie - b.tie;
  });

  const sliced = events.slice(-maxMessages).map((e) => ({ ...e }));
  applyLatestCustomerContent(sliced, interaction, maxLine);
  let text = sliced.map((e) => `${e.role}: ${e.body}`).join('\n');

  if (text.length > maxTotal) {
    text = text.slice(text.length - maxTotal);
    const cut = text.indexOf('\n');
    if (cut > 0) text = text.slice(cut + 1);
  }

  return text;
}

module.exports = {
  buildRecentConversationTranscript,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_TOTAL_CHARS
};
