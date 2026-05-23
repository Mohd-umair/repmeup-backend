'use strict';

const {
  _buildMetaProductPayload,
  _buildBatchProductData,
  _resolveRetailerId,
  _priceMinorUnits
} = require('../../../src/integrations/whatsapp/whatsappCatalogService');

describe('whatsappCatalogService payload builders', () => {
  const baseProduct = {
    _id: '674a1b2c3d4e5f6789012345',
    name: 'Blue Shirt',
    description: 'Cotton shirt',
    price: 49.99,
    currency: 'AED',
    discountPercent: 0,
    images: ['https://cdn.example.com/shirt.jpg'],
    paymentUrl: 'https://shop.example.com/shirt',
    stock: 10
  };

  test('_resolveRetailerId prefers sku over _id', () => {
    expect(_resolveRetailerId({ ...baseProduct, sku: 'SKU-001' })).toBe('SKU-001');
    expect(_resolveRetailerId(baseProduct)).toBe('674a1b2c3d4e5f6789012345');
  });

  test('_priceMinorUnits converts to integer minor units', () => {
    expect(_priceMinorUnits(49.99, 'AED')).toBe(4999);
    expect(_priceMinorUnits(100, 'JPY')).toBe(100);
  });

  test('_buildMetaProductPayload sends price as number (not string)', () => {
    const payload = _buildMetaProductPayload(baseProduct);
    expect(typeof payload.price).toBe('number');
    expect(payload.price).toBe(4999);
    expect(payload.currency).toBe('AED');
    expect(payload.retailer_id).toBe('674a1b2c3d4e5f6789012345');
    expect(payload.image_url).toBe('https://cdn.example.com/shirt.jpg');
    expect(payload.url).toMatch(/^https:\/\//);
  });

  test('_buildMetaProductPayload applies discount to price', () => {
    const payload = _buildMetaProductPayload({ ...baseProduct, discountPercent: 10 });
    // 49.99 * 0.9 = 44.991 → 4499 fils
    expect(payload.price).toBe(4499);
  });

  test('_buildBatchProductData uses string price format for items_batch', () => {
    const data = _buildBatchProductData(baseProduct);
    expect(data.price).toBe('49.99 AED');
    expect(data.id).toBe('674a1b2c3d4e5f6789012345');
    expect(data.title).toBe('Blue Shirt');
    expect(data.image_link).toBe('https://cdn.example.com/shirt.jpg');
    expect(data.link).toBe('https://shop.example.com/shirt');
  });
});
