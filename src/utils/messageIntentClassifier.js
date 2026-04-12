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
 */
function isGibberish(text) {
  const stripped = text.replace(/\s+/g, ' ').trim();
  if (stripped.length === 0) return true;

  const nonAlpha = (stripped.match(/[^a-zA-Z0-9\u00C0-\u024F\u0600-\u06FF\s]/g) || []).length;
  const ratio = nonAlpha / stripped.length;
  if (ratio > 0.6) return true;

  // No real words (≥2 chars) at all and short text
  const words = stripped.split(/\s+/).filter(w => w.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length >= 2);
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

module.exports = {
  classifyMessage,
  isFallbackMessage,
  countPreviousFallbacks,
};
