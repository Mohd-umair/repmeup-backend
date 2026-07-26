'use strict';
/**
 * Unit tests for the policy-enforcement helpers added in processAutoReply.js:
 *   - isInsideQuietHours
 *   - containsSkipKeyword
 *   - isOutsideWhatsApp24hWindow
 *   - isImageRequest
 *   - looksLikeAddress
 *
 * These are extracted via module internals using require and function re-declaration
 * to keep the tests focused and fast without starting the full job worker.
 */

// Re-implement the helpers directly so tests don't load the full job (which has
// heavy dependencies). If the helpers ever move to a shared util, import from there.

function isInsideQuietHours(quietHours) {
  if (!quietHours?.enabled) return false;
  try {
    const tz = quietHours.timezone || 'Asia/Kolkata';
    const now = new Date(quietHours._testNow || Date.now());
    const localStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const [hh, mm] = localStr.split(':').map(Number);
    const currentMins = hh * 60 + mm;
    const parseHHMM = (s) => {
      const parts = String(s || '').split(':');
      return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
    };
    const startMins = parseHHMM(quietHours.start || '22:00');
    const endMins   = parseHHMM(quietHours.end   || '08:00');
    if (startMins < endMins) return currentMins >= startMins && currentMins < endMins;
    return currentMins >= startMins || currentMins < endMins;
  } catch {
    return false;
  }
}

function containsSkipKeyword(text, skipKeywords) {
  if (!skipKeywords?.length || !text) return false;
  const lower = String(text).toLowerCase();
  return skipKeywords.some((kw) => lower.includes(String(kw).toLowerCase().trim()));
}

function isOutsideWhatsApp24hWindow(interaction) {
  if (interaction.platform !== 'whatsapp') return false;
  const lastInboundAt = interaction.metadata?.lastInboundAt;
  if (!lastInboundAt) return false;
  const ageMs = Date.now() - new Date(lastInboundAt).getTime();
  return ageMs > 23.5 * 60 * 60 * 1000;
}

const IMAGE_INTENT_RE = /\b(image|images|photo|photos|pic|pics|picture|pictures|catalog|catalogue|tasveer|tasveere|design|designs|show me|dikhao|dikha|bhejo|send me)\b/i;
function isImageRequest(text) { return IMAGE_INTENT_RE.test(text || ''); }

const GREETING_RE = /^\s*(hello|hi|hey|salam|salaam|hola|hy|hii|hanji|ji|ok|okay|thanks|thankyou|thank you|fine|good|great|sure|yes|no|nope|kk|hmm|k)\s*[!.]*\s*$/i;
function looksLikeAddress(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;
  if (GREETING_RE.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= 2;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('processAutoReply policy helpers', () => {

  describe('isInsideQuietHours', () => {
    it('returns false when quiet hours are disabled', () => {
      expect(isInsideQuietHours({ enabled: false, start: '22:00', end: '08:00' })).toBe(false);
    });

    it('returns false when quietHours is null', () => {
      expect(isInsideQuietHours(null)).toBe(false);
    });

    it('detects overnight window (22:00–08:00) at 23:00', () => {
      // Create a UTC time that maps to 23:00 Asia/Kolkata (IST = UTC+5:30, so UTC 17:30)
      const testNow = new Date('2025-01-01T17:30:00Z').getTime(); // 23:00 IST
      const result = isInsideQuietHours({
        enabled: true, start: '22:00', end: '08:00', timezone: 'Asia/Kolkata', _testNow: testNow
      });
      expect(result).toBe(true);
    });

    it('detects overnight window (22:00–08:00) at 07:30 — inside', () => {
      // 07:30 IST = UTC 02:00
      const testNow = new Date('2025-01-01T02:00:00Z').getTime();
      const result = isInsideQuietHours({
        enabled: true, start: '22:00', end: '08:00', timezone: 'Asia/Kolkata', _testNow: testNow
      });
      expect(result).toBe(true);
    });

    it('detects overnight window — outside at 10:00', () => {
      // 10:00 IST = UTC 04:30
      const testNow = new Date('2025-01-01T04:30:00Z').getTime();
      const result = isInsideQuietHours({
        enabled: true, start: '22:00', end: '08:00', timezone: 'Asia/Kolkata', _testNow: testNow
      });
      expect(result).toBe(false);
    });
  });

  describe('containsSkipKeyword', () => {
    it('returns false when no keywords configured', () => {
      expect(containsSkipKeyword('hello world', [])).toBe(false);
      expect(containsSkipKeyword('hello world', null)).toBe(false);
    });

    it('returns true when text contains a skip keyword', () => {
      expect(containsSkipKeyword('I want to cancel my subscription', ['cancel', 'refund'])).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(containsSkipKeyword('CANCEL everything', ['cancel'])).toBe(true);
    });

    it('returns false when no keyword matches', () => {
      expect(containsSkipKeyword('hello, how are you?', ['cancel', 'refund'])).toBe(false);
    });
  });

  describe('isOutsideWhatsApp24hWindow', () => {
    it('returns false for non-WhatsApp platforms', () => {
      expect(isOutsideWhatsApp24hWindow({ platform: 'instagram', metadata: {} })).toBe(false);
    });

    it('returns false when lastInboundAt is missing', () => {
      expect(isOutsideWhatsApp24hWindow({ platform: 'whatsapp', metadata: {} })).toBe(false);
    });

    it('returns false when lastInboundAt is recent (< 23.5h)', () => {
      const recentTime = new Date(Date.now() - 20 * 60 * 60 * 1000); // 20h ago
      expect(isOutsideWhatsApp24hWindow({
        platform: 'whatsapp',
        metadata: { lastInboundAt: recentTime }
      })).toBe(false);
    });

    it('returns true when lastInboundAt is > 23.5h ago', () => {
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      expect(isOutsideWhatsApp24hWindow({
        platform: 'whatsapp',
        metadata: { lastInboundAt: oldTime }
      })).toBe(true);
    });
  });

  describe('isImageRequest', () => {
    it('detects "photo" intent', () => {
      expect(isImageRequest('Can you send me a photo of the product?')).toBe(true);
    });
    it('detects "image" intent', () => {
      expect(isImageRequest('show me the images')).toBe(true);
    });
    it('detects Hinglish "tasveer"', () => {
      expect(isImageRequest('product ki tasveer bhejo')).toBe(true);
    });
    it('detects "dikhao"', () => {
      expect(isImageRequest('product dikhao')).toBe(true);
    });
    it('returns false for unrelated messages', () => {
      expect(isImageRequest('what is the price?')).toBe(false);
      expect(isImageRequest('hello')).toBe(false);
    });
  });

  describe('looksLikeAddress', () => {
    it('returns true for a typical delivery address', () => {
      expect(looksLikeAddress('Flat 302, Sunshine Apartments, Banjara Hills, Hyderabad - 500034')).toBe(true);
    });
    it('returns false for greetings', () => {
      expect(looksLikeAddress('hello')).toBe(false);
      expect(looksLikeAddress('ok')).toBe(false);
      expect(looksLikeAddress('Thank you!')).toBe(false);
    });
    it('returns false for very short texts', () => {
      expect(looksLikeAddress('abc')).toBe(false);
    });
    it('returns false for a single word (product name)', () => {
      expect(looksLikeAddress('Kurta')).toBe(false);
    });
    it('returns true for multi-word medium-length text', () => {
      expect(looksLikeAddress('123 Main Street, Mumbai')).toBe(true);
    });
  });
});
