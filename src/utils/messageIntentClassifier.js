/**
 * Message Intent Classifier
 *
 * Pre-AI classification layer that detects the intent of a customer message
 * without spending AI credits. Used in processAutoReply to gate which path
 * the conversation takes before calling the LLM.
 *
 * Returns one of: 'closing' | 'small_talk' | 'gibberish' | 'business'
 */

// ─── Closing / satisfied patterns ────────────────────────────────────────────
// Short messages indicating the conversation is over or the customer is satisfied.
// When detected the conversation is resolved silently with no reply.
const CLOSING_PATTERNS = [
  /^thank(s|you|u)\b/i,
  /\bthank\s*(you|u|you\s*so\s*much|you\s*very\s*much)\b/i,
  /^ok(ay)?\s*[.!]?\s*thank/i,
  /^ok(ay)?\s*[.!]?\s*$/i,
  /^ok(ay)?\s*got\s*it/i,
  /^got\s*it\s*[.!]?\s*$/i,
  /^perfect\s*[.!]?\s*$/i,
  /^great\s*[.!]?\s*$/i,
  /^awesome\s*[.!]?\s*$/i,
  /^wonderful\s*[.!]?\s*$/i,
  /^noted\s*[.!]?\s*$/i,
  /^understood\s*[.!]?\s*$/i,
  /^sounds\s*good\s*[.!]?\s*$/i,
  /^alright\s*[.!]?\s*$/i,
  /^sure\s*[.!]?\s*$/i,
  /\bshukriya\b/i,
  /\bjazak\s*allah\b/i,
  /\bshukran\b/i,
  /\btheek\s*hai\b/i,
  /\bacha\b/i,
  /\baccha\b/i,
  /\bachi\s*baat\b/i,
  /\bsamajh\s*gaya\b/i,
  /\bsamajh\s*gayi\b/i,
  /\bshukriya\b/i,
  /^👍\s*$/,
  /^🙏\s*$/,
  /^😊\s*$/,
  /^✅\s*$/,
];

// ─── Small talk patterns ──────────────────────────────────────────────────────
// Greetings and casual openers. AI should always handle these naturally —
// never route to fallback just because there's no KB article on "hello".
const SMALL_TALK_PATTERNS = [
  /^(hi|hey|hello|helo|hii+|heyyy*)\b/i,
  /^salam\b/i,
  /^assalam/i,
  /^as\s*salamu?\s*alaikum/i,
  /^walaikum/i,
  /^aoa\b/i,
  /^hola\b/i,
  /^bonjour\b/i,
  /^good\s*(morning|afternoon|evening|night)\b/i,
  /^how\s*are\s*you\b/i,
  /^kya\s*haal\b/i,
  /^kaise\s*ho\b/i,
  /^kya\s*hal\b/i,
  /^ap\s*kaise\b/i,
  /^(sup|what'?s\s*up)\b/i,
];

/**
 * Detect gibberish: text is meaningless noise, not a real query.
 * Criteria:
 *  - More than 60% of characters are non-alphanumeric (excluding spaces), OR
 *  - No token (word) of at least 2 chars found in the text (after stripping emoji/punctuation), AND text is short
 *
 * Uses Unicode property escapes (\p{L} = any letter, \p{N} = any number) so that
 * non-Latin scripts (Devanagari/Hindi, Arabic, CJK, Cyrillic, etc.) are treated as
 * valid alphanumeric characters and are never mis-classified as gibberish.
 */
function isGibberish(text) {
  const stripped = text.replace(/\s+/g, ' ').trim();
  if (stripped.length === 0) return true;

  // Count characters that are NOT a Unicode letter, digit, or whitespace
  const nonAlpha = (stripped.match(/[^\p{L}\p{N}\s]/gu) || []).length;
  const ratio = nonAlpha / stripped.length;
  if (ratio > 0.6) return true;

  // No real words (≥2 letter/digit chars) at all and short text
  const words = stripped.split(/\s+/).filter(w => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2);
  if (words.length === 0 && stripped.length < 15) return true;

  return false;
}

/**
 * Classify a customer message into one of four intent types.
 *
 * @param {string} text - The raw message text
 * @returns {'closing' | 'small_talk' | 'gibberish' | 'business'}
 */
function classifyMessage(text) {
  if (!text || typeof text !== 'string') return 'business';

  const trimmed = text.trim();
  if (trimmed.length === 0) return 'gibberish';

  // Closing / satisfied — only check short messages to avoid false positives
  // e.g. "thank you but I still have a question" should NOT be closing
  if (trimmed.length <= 60 && CLOSING_PATTERNS.some(p => p.test(trimmed))) {
    return 'closing';
  }

  // Small talk — greetings, casual openers
  if (trimmed.length <= 80 && SMALL_TALK_PATTERNS.some(p => p.test(trimmed))) {
    return 'small_talk';
  }

  // Gibberish
  if (isGibberish(trimmed)) {
    return 'gibberish';
  }

  return 'business';
}

/**
 * Response Memory check — determines whether the last AI-generated reply in
 * a conversation was already a fallback message, to prevent repetition.
 *
 * @param {string} replyContent - Content of the previous AI reply to check
 * @param {string} primaryFallback - The configured fallback message (first 25 chars used)
 * @returns {boolean}
 */
function isFallbackMessage(replyContent, primaryFallback) {
  if (!replyContent) return false;

  const lower = replyContent.toLowerCase();

  // Check against the configured primary fallback message
  if (primaryFallback) {
    const prefix = primaryFallback.toLowerCase().slice(0, 30);
    if (lower.includes(prefix)) return true;
  }

  // Check against known fallback phrases used by the system
  const FALLBACK_SIGNATURES = [
    'our agent will contact you',
    'agent will get back to you',
    'our team will take it from here',
    'passed this along to our team',
    'our team will reach out',
    'our team is already looking',
    "you'll hear from us",
    "someone will be in touch",
    'connecting you with a team member',
    'our team will get back',
  ];

  return FALLBACK_SIGNATURES.some(sig => lower.includes(sig));
}

/**
 * Count how many times a fallback has already been sent in this conversation.
 *
 * @param {Array} replies - interaction.replies array
 * @param {string} primaryFallback - configured fallback message
 * @returns {number}
 */
function countPreviousFallbacks(replies = [], primaryFallback) {
  return replies.filter(r => r.wasAutoGenerated && isFallbackMessage(r.content, primaryFallback)).length;
}

// ─── Internal AI payload guard ────────────────────────────────────────────────
// Detects strings that are internal AI self-assessment JSON (e.g. leaked via
// a code bug) and must never be sent to customers.

/**
 * Returns true if `content` is internal AI metadata (self-assessment JSON)
 * that was accidentally used as a customer reply.
 *
 * @param {string} content
 * @returns {boolean}
 */
function isInternalAiPayload(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  // Must start with '{' to be JSON
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return false;
    // Internal AI payloads always carry these keys together
    const internalKeys = ['resolvable', 'confidence', 'messageType'];
    const matches = internalKeys.filter(k => Object.prototype.hasOwnProperty.call(parsed, k));
    return matches.length >= 2;
  } catch {
    // If it starts with '{' but fails to parse, check for partial JSON with known keys
    return /["']resolvable["']/.test(trimmed) && /["']messageType["']/.test(trimmed);
  }
}

// ─── Pleasantries / bot-message detection ─────────────────────────────────────
// Patterns that indicate an automated or purely polite response with no real query.
// Unlike CLOSING_PATTERNS these are not length-capped and catch multi-sentence bot replies.

const PLEASANTRIES_ANCHOR = [
  /\bpleasure to connect\b/i,
  /\bpleasure connecting\b/i,
  /\bwonderful day\b/i,
  /\bfantastic day\b/i,
  /\bamazing day\b/i,
  /\bgreat day\b/i,
  /\bbeautiful day\b/i,
  /\bhave a (?:good|great|nice|wonderful|fantastic|amazing|lovely) day\b/i,
  /\bwe['']re always here\b/i,
  /\balways here (?:for you|whenever)\b/i,
  /\bremember we['']re always here\b/i,
  /\bhere whenever you need\b/i,
  /\banytime you need\b/i,
  /\bwishing you (?:a|an)\b/i,
  /\bhope your day\b/i,
  /\btake care(?: and)?\b/i,
];

const THANK_YOU_ANCHOR = [
  /\bthank you\b/i,
  /\bthanks\b/i,
  /\bso much\b/i,
  /\bthat'?s (?:so |really |incredibly |truly )?kind\b/i,
  /\bthat means a lot\b/i,
  /\bthank you so much\b/i,
];

/**
 * Returns true when a message reads like an automated pleasantry or polite
 * bot-generated closing that warrants silent resolution rather than a reply.
 *
 * Matches long bot messages like:
 *   "Thank you so much! It's always a pleasure to connect. Wishing you a
 *    wonderful day ahead! We're always here if you need anything."
 *
 * @param {string} text
 * @returns {boolean}
 */
function isPleasantriesMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();

  // Short messages already handled by CLOSING_PATTERNS in classifyMessage.
  // Here we catch longer automated bot-style messages.
  const hasThankYouAnchor = THANK_YOU_ANCHOR.some(p => p.test(trimmed));
  const hasPleasantriesMarker = PLEASANTRIES_ANCHOR.some(p => p.test(trimmed));

  // A pleasantry message has BOTH a thank-you and a warm-closing marker.
  return hasThankYouAnchor && hasPleasantriesMarker;
}

/**
 * Detect a bot-to-bot conversation loop.
 *
 * Returns true when:
 * - The last 3+ inbound messages (metadata.incomingMessages) are all pleasantries, OR
 * - The last 2+ auto-generated outbound replies are pleasantries AND the latest
 *   inbound is also a pleasantry (classic ping-pong pattern).
 *
 * @param {object} interaction  - Mongoose interaction document (populated)
 * @returns {boolean}
 */
function detectBotConversationLoop(interaction) {
  if (!interaction) return false;

  // Check inbound message history
  const incoming = Array.isArray(interaction.metadata?.incomingMessages)
    ? interaction.metadata.incomingMessages
    : [];

  if (incoming.length >= 3) {
    const lastThree = incoming.slice(-3);
    if (lastThree.every(m => isPleasantriesMessage(m.text || ''))) {
      return true;
    }
  }

  // Check outbound reply history for bot-generated pleasantries
  const replies = Array.isArray(interaction.replies) ? interaction.replies : [];
  const autoReplies = replies.filter(r => r.wasAutoGenerated);

  if (autoReplies.length >= 2) {
    const lastTwo = autoReplies.slice(-2);
    if (lastTwo.every(r => isPleasantriesMessage(r.content || ''))) {
      // Latest inbound also pleasantries → confirmed loop
      const latestInbound = incoming[incoming.length - 1];
      if (latestInbound && isPleasantriesMessage(latestInbound.text || '')) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  classifyMessage,
  isFallbackMessage,
  countPreviousFallbacks,
  isInternalAiPayload,
  isPleasantriesMessage,
  detectBotConversationLoop,
};
