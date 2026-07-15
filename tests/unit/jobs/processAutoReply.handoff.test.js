/**
 * Regression tests for the human-handoff promise detector used by the auto-reply
 * pipeline (processAutoReply.replyPromisesHumanHandoff).
 *
 * Context: the AI sometimes writes an escalation promise into its own reply
 * ("I've escalated this to our priority team, someone will reach out") while
 * self-assessing the query as resolvable. Nothing in the escalation scorer reads
 * the AI's reply, so the conversation was never actually assigned to a human —
 * a broken promise. This detector lets the pipeline catch those replies and
 * guarantee a human is assigned. These cases must keep passing.
 */

const { replyPromisesHumanHandoff } = require('../../../src/jobs/processAutoReply');

describe('replyPromisesHumanHandoff', () => {
  describe('MUST detect (reply promises a human/agent/team will follow up)', () => {
    const promises = [
      // Verbatim lines from the reported production conversation:
      'I’ll escalate this with our team so someone reaches out to you as soon as possible.',
      'I’ve escalated your refund request for ORD-1055 to our priority team, and someone should reach out to you shortly to arrange the pickup.',
      'If you don’t hear from us soon, please let me know here—I’ll follow up again right away.',
      // Common handoff phrasings:
      'If you dont hear back from us soon, let me know.',
      'Our team will reach out to you shortly.',
      'I am connecting you with a team member who can assist you.',
      'Let me put you in touch with our support agent.',
      'I have forwarded your message to our team.',
      'I have passed this along to our team — someone will be in touch shortly.',
      'A team member will contact you soon.',
      'We will arrange the pickup for your return.',
      'Someone from our team will get back to you within 24 hours.',
      'I have raised this with our team and they will follow up.',
    ];
    it.each(promises)('detects: %s', (text) => {
      expect(replyPromisesHumanHandoff(text)).toBe(true);
    });
  });

  describe('MUST NOT detect (ordinary helpful / sales / greeting replies)', () => {
    const benign = [
      'Hi! How can I help you today?',
      'Thanks for your interest! Could you tell me what kind of product you are looking for?',
      'Sure — the blue t-shirt is available in sizes M, L and XL for ₹499.',
      'Great choice! Please share your delivery address so we can process your order.',
      'Yes, we offer free shipping on orders above ₹999.',
      'Our store is open from 9am to 9pm every day.',
      'You are welcome! Let me know if you need anything else.',
      'That product comes with a 7-day return policy.',
      'I will follow up with the exact pricing in a moment.',
    ];
    it.each(benign)('ignores: %s', (text) => {
      expect(replyPromisesHumanHandoff(text)).toBe(false);
    });
  });

  describe('input safety', () => {
    it('returns false for empty / null / non-string input', () => {
      expect(replyPromisesHumanHandoff('')).toBe(false);
      expect(replyPromisesHumanHandoff(null)).toBe(false);
      expect(replyPromisesHumanHandoff(undefined)).toBe(false);
      expect(replyPromisesHumanHandoff(42)).toBe(false);
      expect(replyPromisesHumanHandoff({})).toBe(false);
    });
  });
});
