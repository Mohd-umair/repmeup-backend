const {
  computeReplyDelayMs,
  normalizeAutoReplyDelaySettings,
  MIN_DELAY_MS,
  HUMAN_JITTER_MAX_MS
} = require('../../../src/utils/replyDelayHelper');

describe('replyDelayHelper', () => {
  describe('normalizeAutoReplyDelaySettings', () => {
    it('defaults to fixed mode with 1 minute', () => {
      const s = normalizeAutoReplyDelaySettings({});
      expect(s.replyDelayMode).toBe('fixed');
      expect(s.webhookDelay).toBe(1);
    });
  });

  describe('computeReplyDelayMs', () => {
    it('uses fixed minutes', () => {
      expect(
        computeReplyDelayMs({ replyDelayMode: 'fixed', webhookDelay: 2 })
      ).toBe(2 * 60 * 1000);
    });

    it('enforces minimum floor for very short fixed delay', () => {
      expect(
        computeReplyDelayMs({ replyDelayMode: 'fixed', webhookDelay: 0 })
      ).toBe(MIN_DELAY_MS);
    });

    it('human mode sends ASAP with small natural jitter', () => {
      expect(
        computeReplyDelayMs({ replyDelayMode: 'human' }, { random: () => 0 })
      ).toBe(MIN_DELAY_MS);

      expect(
        computeReplyDelayMs({ replyDelayMode: 'human' }, { random: () => 1 })
      ).toBe(MIN_DELAY_MS + HUMAN_JITTER_MAX_MS);
    });
  });
});
