'use strict';

const {
  sortProductsForPost,
  matchProductByCommentText,
  buildProductPickerElements,
  buildNumberedPickerText,
  filterProductsByPerProductKeywords
} = require('../../../src/services/commentToDmProductHelpers');

describe('commentToDmProductHelpers', () => {
  const postId = '17881020939515532';

  describe('sortProductsForPost', () => {
    it('sorts by sortOrder then slideIndex then name', () => {
      const products = [
        { _id: 'c', name: 'Zebra', instagramPostLinks: [{ postId, sortOrder: 2 }] },
        { _id: 'a', name: 'Apple', instagramPostLinks: [{ postId, sortOrder: 1 }] },
        { _id: 'b', name: 'Banana', instagramPostLinks: [{ postId, slideIndex: 0 }] }
      ];
      const sorted = sortProductsForPost(products, postId);
      expect(sorted.map(p => p._id)).toEqual(['b', 'a', 'c']);
    });
  });

  describe('matchProductByCommentText', () => {
    const products = [
      { _id: '1', name: 'Red Dress', sku: 'RD-01', dmConfig: {} },
      { _id: '2', name: 'Blue Jacket', sku: 'BJ-02', dmConfig: {} }
    ];

    it('returns single product when name matches uniquely', () => {
      const match = matchProductByCommentText(products, 'what is the price for red dress?');
      expect(match?._id).toBe('1');
    });

    it('returns null when multiple or no matches', () => {
      expect(matchProductByCommentText(products, 'price?')).toBeNull();
      expect(matchProductByCommentText(products, 'red dress and blue jacket')).toBeNull();
    });

    it('matches by sku', () => {
      const match = matchProductByCommentText(products, 'interested in bj-02');
      expect(match?._id).toBe('2');
    });
  });

  describe('buildProductPickerElements', () => {
    it('builds postback payloads with PICK prefix', () => {
      const products = [
        { _id: 'abc123', name: 'Item A', price: 99, currency: 'AED', images: [] }
      ];
      const elements = buildProductPickerElements(products, 'tok_xyz');
      expect(elements).toHaveLength(1);
      expect(elements[0].buttons[0].payload).toBe('PICK:abc123:tok_xyz');
      expect(elements[0].subtitle).toContain('AED');
    });
  });

  describe('buildNumberedPickerText', () => {
    it('lists numbered products', () => {
      const text = buildNumberedPickerText([
        { name: 'A', price: 10, currency: 'AED' },
        { name: 'B', price: 20, currency: 'AED' }
      ], 'jane');
      expect(text).toContain('1. A');
      expect(text).toContain('2. B');
      expect(text).toContain('@jane');
    });
  });

  describe('filterProductsByPerProductKeywords', () => {
    it('keeps products without per-product keywords', () => {
      const products = [
        { _id: '1', dmConfig: {} },
        { _id: '2', dmConfig: { triggerKeywords: ['dress'] } }
      ];
      const filtered = filterProductsByPerProductKeywords(products, 'price for dress');
      expect(filtered.map(p => p._id)).toEqual(['1', '2']);
    });

    it('excludes products whose keywords do not match', () => {
      const products = [
        { _id: '1', dmConfig: { triggerKeywords: ['shoes'] } },
        { _id: '2', dmConfig: { triggerKeywords: ['dress'] } }
      ];
      const filtered = filterProductsByPerProductKeywords(products, 'price for dress');
      expect(filtered.map(p => p._id)).toEqual(['2']);
    });
  });
});
