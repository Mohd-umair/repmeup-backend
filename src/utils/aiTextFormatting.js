/**
 * Post-processing for AI-generated customer messages.
 *
 * The prompt asks the model not to emit Markdown, but prompts are guidance, not
 * a guarantee — and the failure is customer-visible: WhatsApp renders bold as
 * *single asterisks*, so a stray **ORD-1026** reaches the customer with the
 * asterisks intact. This pass makes that deterministic.
 */

/** Channels where *single asterisk* is real bold; elsewhere markup is stripped. */
const ASTERISK_BOLD_PLATFORMS = new Set(['whatsapp']);

/**
 * Convert Markdown emphasis the model may have emitted into something the
 * target channel actually renders.
 *
 * @param {string} text Raw model output
 * @param {string} [platform] Interaction platform, e.g. 'whatsapp'
 * @returns {string}
 */
function stripMarkdownForMessaging(text, platform = '') {
  if (!text || typeof text !== 'string') return text || '';

  const boldReplacement = ASTERISK_BOLD_PLATFORMS.has(String(platform).toLowerCase())
    ? '*$1*'
    : '$1';

  return text
    // **bold** / __bold__ → channel-appropriate emphasis
    .replace(/\*\*([^*\n]+)\*\*/g, boldReplacement)
    .replace(/__([^_\n]+)__/g, boldReplacement)
    // ### headings → plain line
    .replace(/^#{1,6}\s+/gm, '')
    // `code` → bare text (backticks read as noise in a chat message)
    .replace(/`([^`\n]+)`/g, '$1')
    // [label](url) → "label (url)" so the link survives
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    // collapse 3+ blank lines the model sometimes leaves behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { stripMarkdownForMessaging };
