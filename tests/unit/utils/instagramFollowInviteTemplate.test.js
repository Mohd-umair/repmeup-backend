'use strict';

const {
  buildFollowInviteGenericElement,
  normalizeHttpsProfileUrl,
  MAX_TITLE,
  MAX_SUBTITLE,
  MAX_BUTTON_TITLE
} = require('../../../src/utils/instagramFollowInviteTemplate');

describe('instagramFollowInviteTemplate', () => {
  describe('normalizeHttpsProfileUrl', () => {
    it('returns https instagram URL for plain handle', () => {
      expect(normalizeHttpsProfileUrl('mybrand')).toBe('https://www.instagram.com/mybrand/');
    });

    it('strips leading @', () => {
      expect(normalizeHttpsProfileUrl('@shop')).toBe('https://www.instagram.com/shop/');
    });

    it('returns null for empty input', () => {
      expect(normalizeHttpsProfileUrl('')).toBe(null);
      expect(normalizeHttpsProfileUrl(null)).toBe(null);
    });
  });

  describe('buildFollowInviteGenericElement', () => {
    it('builds element with web_url button', () => {
      const el = buildFollowInviteGenericElement({
        title: 'Thanks!',
        subtitle: 'Follow us',
        buttonTitle: 'Follow',
        buttonUrl: 'https://www.instagram.com/acme/'
      });
      expect(el.title).toBe('Thanks!');
      expect(el.subtitle).toBe('Follow us');
      expect(el.buttons).toEqual([
        { type: 'web_url', url: 'https://www.instagram.com/acme/', title: 'Follow' }
      ]);
      expect(el.image_url).toBeUndefined();
    });

    it('omits subtitle when empty', () => {
      const el = buildFollowInviteGenericElement({
        title: 'Hi',
        subtitle: '',
        buttonTitle: 'Go',
        buttonUrl: 'https://example.com/'
      });
      expect(el.subtitle).toBeUndefined();
    });

    it('includes https image_url when valid', () => {
      const el = buildFollowInviteGenericElement({
        title: 'T',
        buttonTitle: 'B',
        buttonUrl: 'https://www.instagram.com/x/',
        imageUrl: 'https://cdn.example.com/i.jpg'
      });
      expect(el.image_url).toBe('https://cdn.example.com/i.jpg');
    });

    it('ignores non-https imageUrl', () => {
      const el = buildFollowInviteGenericElement({
        title: 'T',
        buttonTitle: 'B',
        buttonUrl: 'https://www.instagram.com/x/',
        imageUrl: 'http://insecure.com/x.png'
      });
      expect(el.image_url).toBeUndefined();
    });

    it('throws when buttonUrl is not https', () => {
      expect(() =>
        buildFollowInviteGenericElement({
          title: 'T',
          buttonTitle: 'B',
          buttonUrl: 'http://example.com/'
        })
      ).toThrow(/https/);
    });

    it('trims and truncates strings to Meta limits', () => {
      const longTitle = 'x'.repeat(MAX_TITLE + 50);
      const longSub = 'y'.repeat(MAX_SUBTITLE + 30);
      const longBtn = 'z'.repeat(MAX_BUTTON_TITLE + 10);
      const el = buildFollowInviteGenericElement({
        title: longTitle,
        subtitle: longSub,
        buttonTitle: longBtn,
        buttonUrl: 'https://www.instagram.com/a/'
      });
      expect(el.title.length).toBe(MAX_TITLE);
      expect(el.subtitle.length).toBe(MAX_SUBTITLE);
      expect(el.buttons[0].title.length).toBe(MAX_BUTTON_TITLE);
    });

    it('uses defaults when fields missing', () => {
      const el = buildFollowInviteGenericElement({
        buttonUrl: 'https://www.instagram.com/h/'
      });
      expect(el.title).toBe('Thanks!');
      expect(el.buttons[0].title).toBe('Follow');
    });
  });
});
