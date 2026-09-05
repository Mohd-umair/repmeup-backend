'use strict';

const {
  _buildMetaProductPayload,
  _buildBatchProductData,
  _buildCommerceBatchFields,
  _buildCommerceProductsFields,
  _resolveRetailerId,
  _priceMinorUnits,
  _productLink,
  _additionalImageUrls
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

  // BEHAVIOR CHANGE (Meta alignment): price stays the BASE price; the discount
  // is expressed via sale_price so WhatsApp shows the strikethrough.
  test('discount produces sale_price; price remains the base price', () => {
    const payload = _buildMetaProductPayload({ ...baseProduct, discountPercent: 10 });
    expect(payload.price).toBe(4999);          // base, minor units
    expect(payload.sale_price).toBe(4499);     // 49.99 * 0.9 → minor units

    const batch = _buildBatchProductData({ ...baseProduct, discountPercent: 10 });
    expect(batch.price).toBe('49.99 AED');
    expect(batch.sale_price).toBe('44.99 AED');
  });

  test('no sale_price when there is no discount', () => {
    expect(_buildMetaProductPayload(baseProduct).sale_price).toBeUndefined();
    expect(_buildBatchProductData(baseProduct).sale_price).toBeUndefined();
  });

  test('_buildBatchProductData uses string price format for items_batch', () => {
    const data = _buildBatchProductData(baseProduct);
    expect(data.price).toBe('49.99 AED');
    expect(data.id).toBe('674a1b2c3d4e5f6789012345');
    expect(data.title).toBe('Blue Shirt');
    expect(data.image_link).toBe('https://cdn.example.com/shirt.jpg');
    expect(data.link).toBe('https://shop.example.com/shirt');
  });

  test('defaults to INR when product has no currency', () => {
    const { currency, ...noCur } = baseProduct;
    expect(_buildBatchProductData(noCur).price).toBe('49.99 INR');
    expect(_buildMetaProductPayload(noCur).currency).toBe('INR');
  });

  describe('link precedence', () => {
    test('websiteUrl wins over paymentUrl', () => {
      expect(_productLink({ ...baseProduct, websiteUrl: 'https://brand.example.com/p/1' }))
        .toBe('https://brand.example.com/p/1');
    });
    test('falls back to paymentUrl, then placeholder', () => {
      expect(_productLink(baseProduct)).toBe('https://shop.example.com/shirt');
      expect(_productLink({ ...baseProduct, paymentUrl: '' })).toBe('https://example.com');
    });
    test('non-https websiteUrl is skipped', () => {
      expect(_productLink({ ...baseProduct, websiteUrl: 'http://insecure.example.com' }))
        .toBe('https://shop.example.com/shirt');
    });
  });

  describe('availability', () => {
    test('derived from stock when no override', () => {
      expect(_buildBatchProductData({ ...baseProduct, stock: 0 }).availability).toBe('out of stock');
      expect(_buildBatchProductData({ ...baseProduct, stock: null }).availability).toBe('in stock');
    });
    test('commerce.availability override wins over stock', () => {
      const p = { ...baseProduct, stock: 0, commerce: { availability: 'in stock' } };
      expect(_buildBatchProductData(p).availability).toBe('in stock');
      expect(_buildMetaProductPayload(p).availability).toBe('in stock');
    });
  });

  describe('condition', () => {
    test('defaults to new; commerce.condition overrides', () => {
      expect(_buildBatchProductData(baseProduct).condition).toBe('new');
      expect(_buildBatchProductData({ ...baseProduct, commerce: { condition: 'refurbished' } }).condition)
        .toBe('refurbished');
    });
  });

  describe('additional images', () => {
    test('images[1..20] become additional_image_link (https only)', () => {
      const images = ['https://cdn.example.com/main.jpg'];
      for (let i = 1; i <= 25; i++) images.push(`https://cdn.example.com/extra${i}.jpg`);

      const extra = _additionalImageUrls({ images });
      expect(extra).toHaveLength(20);
      expect(extra[0]).toBe('https://cdn.example.com/extra1.jpg');

      const batch = _buildBatchProductData({ ...baseProduct, images });
      expect(batch.image_link).toBe('https://cdn.example.com/main.jpg');
      expect(batch.additional_image_link).toHaveLength(20);
    });
    test('non-https additional images are filtered out', () => {
      const extra = _additionalImageUrls({
        images: ['https://cdn.example.com/main.jpg', 'http://not-https.example.com/x.jpg', 'https://cdn.example.com/ok.jpg']
      });
      expect(extra).toEqual(['https://cdn.example.com/ok.jpg']);
    });
    test('omitted entirely with a single image', () => {
      expect(_buildBatchProductData(baseProduct).additional_image_link).toBeUndefined();
    });
  });

  describe('commerce field mapping — batch (feed) names', () => {
    const commerce = {
      brand: 'RepMeUp Wear',
      gtin: '8901234567890',
      mpn: 'RMW-42',
      googleProductCategory: 'Apparel & Accessories > Clothing',
      fbProductCategory: 'Clothing',
      productType: 'Shirts > Casual',
      itemGroupId: 'SHIRT-GRP-1',
      color: 'Royal Blue',
      size: 'M',
      gender: 'unisex',
      ageGroup: 'adult',
      material: 'Organic Cotton',
      pattern: 'Solid',
      originCountry: 'IN',
      importerName: 'RepMeUp Imports Pvt Ltd',
      importerAddress: { street1: '1 MG Road', city: 'Bengaluru', postalCode: '560001', country: 'IN' },
      manufacturerInfo: 'RepMeUp Textiles, Tirupur 641604',
      waComplianceCategory: 'DEFAULT',
      shippingWeight: { value: 0.5, unit: 'kg' }
    };

    test('maps every field to the items_batch name', () => {
      const out = _buildCommerceBatchFields({ ...baseProduct, commerce });
      expect(out).toMatchObject({
        brand: 'RepMeUp Wear',
        gtin: '8901234567890',
        mpn: 'RMW-42',
        google_product_category: 'Apparel & Accessories > Clothing',
        fb_product_category: 'Clothing',
        product_type: 'Shirts > Casual',
        item_group_id: 'SHIRT-GRP-1',
        color: 'Royal Blue',
        size: 'M',
        gender: 'unisex',
        age_group: 'adult',
        material: 'Organic Cotton',
        pattern: 'Solid',
        origin_country: 'IN',
        importer_name: 'RepMeUp Imports Pvt Ltd',
        importer_address: { street1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
        manufacturer_info: 'RepMeUp Textiles, Tirupur 641604',
        wa_compliance_category: 'DEFAULT',
        shipping_weight: '0.5 kg',
        status: 'active'
      });
    });

    test('/products fallback uses its own param names', () => {
      const out = _buildCommerceProductsFields({ ...baseProduct, commerce });
      expect(out.manufacturer_part_number).toBe('RMW-42');
      expect(out.retailer_product_group_id).toBe('SHIRT-GRP-1');
      expect(out.category).toBe('Apparel & Accessories > Clothing');
      expect(out.mpn).toBeUndefined();
      expect(out.item_group_id).toBeUndefined();
    });

    test('inactive product maps to archived status', () => {
      expect(_buildCommerceBatchFields({ ...baseProduct, isActive: false }).status).toBe('archived');
    });

    test('empty commerce adds no attribute keys', () => {
      const out = _buildCommerceBatchFields(baseProduct);
      expect(out.brand).toBeUndefined();
      expect(out.gtin).toBeUndefined();
      expect(out.importer_address).toBeUndefined();
      expect(out.status).toBe('active'); // status always present
    });
  });

  describe('sale_price_effective_date', () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const end = new Date('2026-08-15T00:00:00Z');

    test('sent only when discount AND both dates present', () => {
      const withWindow = _buildCommerceBatchFields({
        ...baseProduct,
        discountPercent: 20,
        commerce: { salePriceStart: start, salePriceEnd: end }
      });
      expect(withWindow.sale_price).toBe('39.99 AED');
      expect(withWindow.sale_price_effective_date)
        .toBe('2026-08-01T00:00:00.000Z/2026-08-15T00:00:00.000Z');
    });

    test('discount without dates → sale_price alone', () => {
      const out = _buildCommerceBatchFields({ ...baseProduct, discountPercent: 20 });
      expect(out.sale_price).toBe('39.99 AED');
      expect(out.sale_price_effective_date).toBeUndefined();
    });

    test('dates without discount → neither sent', () => {
      const out = _buildCommerceBatchFields({
        ...baseProduct,
        commerce: { salePriceStart: start, salePriceEnd: end }
      });
      expect(out.sale_price).toBeUndefined();
      expect(out.sale_price_effective_date).toBeUndefined();
    });
  });
});
