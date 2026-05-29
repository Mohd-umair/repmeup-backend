'use strict';

const {
  sortProductsForPost,
  matchProductByCommentText,
  buildProductPickerElements,
  buildNumberedPickerText,
  filterProductsByPerProductKeywords
} = require('../../../src/services/commentToDmProductHelpers');

describe('buildPostLinkedProductQuery / mergeProductsById', () => {
  const { buildPostLinkedProductQuery, mergeProductsById } = require('../../../src/services/commentToDmProductHelpers');

  it('buildPostLinkedProductQuery matches instagramPostIds and instagramPostLinks', () => {
    const q = buildPostLinkedProductQuery('org1', '17881020939515532');
    expect(q.organization).toBe('org1');
    expect(q.isActive).toBe(true);
    expect(q.$or).toEqual([
      { instagramPostIds: '17881020939515532' },
      { 'instagramPostLinks.postId': '17881020939515532' }
    ]);
  });

  it('mergeProductsById dedupes by _id', () => {
    const merged = mergeProductsById(
      [{ _id: 'a', name: 'A' }],
      [{ _id: 'a', name: 'A2' }, { _id: 'b', name: 'B' }]
    );
    expect(merged.map(p => p._id)).toEqual(['a', 'b']);
    expect(merged[0].name).toBe('A');
  });
});

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
    it('builds postback payloads with PICK prefix when no CTA buttons', () => {
      const products = [
        { _id: 'abc123', name: 'Item A', price: 99, currency: 'AED', images: [] }
      ];
      const elements = buildProductPickerElements(products, 'tok_xyz');
      expect(elements).toHaveLength(1);
      expect(elements[0].buttons[0].payload).toBe('PICK:abc123:tok_xyz');
      expect(elements[0].buttons[0].title).toBe('Select');
      expect(elements[0].subtitle).toContain('AED');
    });

    it('uses per-product dmConfig CTA buttons when order tokens provided', () => {
      const products = [{
        _id: 'abc123',
        name: 'Item A',
        price: 99,
        currency: 'AED',
        images: [],
        paymentUrl: 'https://shop.example/pay',
        dmConfig: {
          ctaTitle: 'Buy Item A',
          ctaSubtitle: 'Limited stock',
          ctaButtons: [
            { label: 'Details', type: 'postback', payload: 'details' },
            { label: 'Pay Now', type: 'postback', payload: 'payment' }
          ]
        }
      }];
      const sfSettings = { ctaButtons: [{ label: 'Global', type: 'postback', payload: 'details' }] };
      const elements = buildProductPickerElements(products, 'tok_xyz', sfSettings, { abc123: 'ord_1' });
      expect(elements[0].title).toBe('Buy Item A');
      expect(elements[0].subtitle).toBe('Limited stock');
      expect(elements[0].buttons).toHaveLength(2);
      expect(elements[0].buttons[0].title).toBe('Details');
      expect(elements[0].buttons[0].payload).toBe('SALES:details:ord_1');
      expect(elements[0].buttons[1].payload).toBe('SALES:payment:ord_1');
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
