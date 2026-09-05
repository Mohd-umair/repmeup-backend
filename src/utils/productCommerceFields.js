'use strict';

/**
 * Meta/WhatsApp Commerce catalog fields — single source of truth.
 *
 * Shared by:
 *   - models/Product.js            (enum validators on the `commerce` subdoc)
 *   - middlewares/productValidation.js  (Joi schema at the route boundary)
 *   - controllers (import paths)   (lenient coercion: drop bad values + warn,
 *                                   never reject a whole row)
 *   - integrations/whatsapp/whatsappCatalogService.js (payload derivation)
 *
 * Field spec source: Meta Commerce Platform catalog fields reference
 * (developers.facebook.com → Commerce Platform → Catalog → Fields).
 */

const Joi = require('joi');

// ── Enums / constants (values exactly as Meta expects them) ───────────────────

const CONDITIONS = ['new', 'refurbished', 'used'];
const AVAILABILITY_VALUES = ['in stock', 'out of stock'];
const GENDERS = ['female', 'male', 'unisex'];
const AGE_GROUPS = ['adult', 'all ages', 'teen', 'kids', 'toddler', 'infant', 'newborn'];
const WA_COMPLIANCE_CATEGORIES = ['COUNTRY_ORIGIN_EXEMPT', 'DEFAULT'];
const WEIGHT_UNITS = ['kg', 'g', 'lb', 'oz'];
const UNIT_PRICE_UNITS = [
  'cl', 'cm', 'ct', 'cbm', 'ft', 'fl oz', 'gal', 'g', 'in', 'kg', 'l', 'm',
  'mg', 'ml', 'oz', 'pt', 'lb', 'qt', 'sqft', 'sqm', 'yd'
];

const DEFAULT_CURRENCY = 'INR';
const MAX_ADDITIONAL_IMAGES = 20;
const MAX_VIDEO_URLS = 20;

// Availability aliases seen in CSV imports / external platforms.
const AVAILABILITY_ALIASES = new Map([
  ['in stock', 'in stock'], ['in_stock', 'in stock'], ['instock', 'in stock'],
  ['available', 'in stock'], ['yes', 'in stock'],
  ['out of stock', 'out of stock'], ['out_of_stock', 'out of stock'],
  ['outofstock', 'out of stock'], ['unavailable', 'out of stock'],
  ['sold out', 'out of stock'], ['soldout', 'out of stock'], ['no', 'out of stock']
]);

// ── Normalizers ───────────────────────────────────────────────────────────────

/**
 * GTIN: strip dashes/spaces; valid = 8–14 digits (covers GTIN-8/12/13/14, ISBN-13).
 * @returns {string|null} normalized digits or null when invalid/empty
 */
function normalizeGtin(raw) {
  const s = String(raw == null ? '' : raw).replace(/[-\s]/g, '');
  if (!s) return null;
  return /^\d{8,14}$/.test(s) ? s : null;
}

/** 'In Stock' / 'in_stock' / 'available' → 'in stock'; unknown → null. */
function normalizeAvailability(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  return AVAILABILITY_ALIASES.get(s) || null;
}

/** Parse "0.5 kg" / "500g" / {value,unit} into { value, unit } or null. */
function parseShippingWeight(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') {
    const value = Number(raw.value);
    const unit = String(raw.unit || '').trim().toLowerCase();
    if (Number.isFinite(value) && value > 0 && WEIGHT_UNITS.includes(unit)) {
      return { value, unit };
    }
    return null;
  }
  const m = String(raw).trim().toLowerCase().match(/^([\d.]+)\s*(kg|g|lb|oz)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: m[2] };
}

// ── Field coercion (shared by strict + lenient paths) ─────────────────────────

const trimmed = (v) => (v == null ? '' : String(v).trim());
const truncate = (v, max) => trimmed(v).slice(0, max);

/**
 * Coerce a raw object of commerce inputs into a clean `commerce` subdoc shape.
 *
 * Lenient mode (imports): invalid values are DROPPED with a warning — a bad
 * enum never rejects the row. Strict mode collects `errors` instead (the Joi
 * route schema is the primary strict gate; this covers non-body paths).
 *
 * @param {object} raw               plain object (camelCase or snake_case keys)
 * @param {object} [opts]
 * @param {boolean} [opts.lenient=false]
 * @returns {{ commerce: object|null, warnings: string[], errors: string[] }}
 */
function coerceCommerceFields(raw, opts = {}) {
  const lenient = opts.lenient === true;
  const warnings = [];
  const errors = [];
  if (!raw || typeof raw !== 'object') return { commerce: null, warnings, errors };

  // Accept snake_case (CSV/feeds) and camelCase (API) key spellings.
  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] != null && raw[k] !== '') return raw[k];
    }
    return undefined;
  };

  const bad = (field, value) => {
    const msg = `${field}: invalid value "${String(value).slice(0, 60)}" — dropped`;
    if (lenient) warnings.push(msg);
    else errors.push(msg.replace(' — dropped', ''));
  };

  const out = {};

  const setStr = (field, value, max) => {
    if (value === undefined) return;
    const s = truncate(value, max);
    if (s) out[field] = s;
  };

  const setEnum = (field, value, allowed, transform = (s) => s.toLowerCase()) => {
    if (value === undefined) return;
    const s = transform(trimmed(value));
    if (allowed.includes(s)) out[field] = s;
    else bad(field, value);
  };

  setStr('brand', pick('brand'), 100);
  setEnum('condition', pick('condition'), CONDITIONS);

  const availabilityRaw = pick('availability');
  if (availabilityRaw !== undefined) {
    const norm = normalizeAvailability(availabilityRaw);
    if (norm) out.availability = norm;
    else bad('availability', availabilityRaw);
  }

  const gtinRaw = pick('gtin', 'barcode', 'upc', 'ean');
  if (gtinRaw !== undefined) {
    const gtin = normalizeGtin(gtinRaw);
    if (gtin) out.gtin = gtin;
    else bad('gtin', gtinRaw);
  }

  setStr('mpn', pick('mpn'), 100);
  setStr('googleProductCategory', pick('googleProductCategory', 'google_product_category'), 750);
  setStr('fbProductCategory', pick('fbProductCategory', 'fb_product_category'), 750);
  setStr('productType', pick('productType', 'product_type'), 750);
  setStr('itemGroupId', pick('itemGroupId', 'item_group_id'), 100);
  setStr('color', pick('color', 'colour'), 200);
  setStr('size', pick('size'), 200);
  setEnum('gender', pick('gender'), GENDERS);
  setEnum('ageGroup', pick('ageGroup', 'age_group'), AGE_GROUPS);
  setStr('material', pick('material'), 200);
  setStr('pattern', pick('pattern'), 100);

  const originRaw = pick('originCountry', 'origin_country');
  if (originRaw !== undefined) {
    const cc = trimmed(originRaw).toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) out.originCountry = cc;
    else bad('originCountry', originRaw);
  }

  setStr('importerName', pick('importerName', 'importer_name'), 200);
  setStr('manufacturerInfo', pick('manufacturerInfo', 'manufacturer_info'), 1000);
  setEnum(
    'waComplianceCategory',
    pick('waComplianceCategory', 'wa_compliance_category'),
    WA_COMPLIANCE_CATEGORIES,
    (s) => s.toUpperCase()
  );

  const addrRaw = pick('importerAddress', 'importer_address');
  if (addrRaw && typeof addrRaw === 'object') {
    const a = addrRaw;
    const addr = {};
    const setAddr = (k, v, max = 200) => { const s = truncate(v, max); if (s) addr[k] = s; };
    setAddr('street1', a.street1 ?? a.street_1);
    setAddr('street2', a.street2 ?? a.street_2);
    setAddr('city', a.city);
    setAddr('region', a.region ?? a.state);
    setAddr('postalCode', a.postalCode ?? a.postal_code, 20);
    const ccRaw = trimmed(a.country).toUpperCase();
    if (ccRaw) {
      if (/^[A-Z]{2}$/.test(ccRaw)) addr.country = ccRaw;
      else bad('importerAddress.country', a.country);
    }
    if (Object.keys(addr).length) out.importerAddress = addr;
  }

  const spStart = pick('salePriceStart', 'sale_price_start');
  const spEnd = pick('salePriceEnd', 'sale_price_end');
  if (spStart !== undefined || spEnd !== undefined) {
    const start = spStart ? new Date(spStart) : null;
    const end = spEnd ? new Date(spEnd) : null;
    const validStart = start && !isNaN(start.getTime());
    const validEnd = end && !isNaN(end.getTime());
    if (validStart && validEnd && end > start) {
      out.salePriceStart = start;
      out.salePriceEnd = end;
    } else {
      bad('salePriceStart/salePriceEnd', `${spStart} / ${spEnd}`);
    }
  }

  const upRaw = pick('unitPrice', 'unit_price');
  if (upRaw && typeof upRaw === 'object') {
    const value = Number(upRaw.value);
    const currency = trimmed(upRaw.currency).toUpperCase();
    const unit = trimmed(upRaw.unit).toLowerCase();
    if (Number.isFinite(value) && value > 0 && /^[A-Z]{3}$/.test(currency) && UNIT_PRICE_UNITS.includes(unit)) {
      out.unitPrice = { value, currency, unit };
    } else {
      bad('unitPrice', JSON.stringify(upRaw).slice(0, 60));
    }
  }

  const weightRaw = pick('shippingWeight', 'shipping_weight');
  if (weightRaw !== undefined) {
    const w = parseShippingWeight(weightRaw);
    if (w) out.shippingWeight = w;
    else bad('shippingWeight', typeof weightRaw === 'object' ? JSON.stringify(weightRaw) : weightRaw);
  }

  const videosRaw = pick('videoUrls', 'video_urls');
  if (videosRaw !== undefined) {
    const list = (Array.isArray(videosRaw) ? videosRaw : String(videosRaw).split(/[\n,]/))
      .map((u) => trimmed(u))
      .filter((u) => /^https:\/\//i.test(u))
      .slice(0, MAX_VIDEO_URLS);
    if (list.length) out.videoUrls = list;
  }

  return {
    commerce: Object.keys(out).length ? out : null,
    warnings,
    errors
  };
}

// ── Joi schema (strict, route boundary) ───────────────────────────────────────

/** Joi object for `commerce` in create/update payloads. */
function buildCommerceJoiSchema() {
  return Joi.object({
    brand: Joi.string().trim().max(100).allow(''),
    condition: Joi.string().lowercase().valid(...CONDITIONS).allow(''),
    availability: Joi.string().lowercase().valid(...AVAILABILITY_VALUES).allow(''),
    gtin: Joi.string().custom((value, helpers) => {
      const g = normalizeGtin(value);
      if (!g) return helpers.error('any.invalid');
      return g;
    }).message('gtin must be 8-14 digits (dashes/spaces allowed)').allow(''),
    mpn: Joi.string().trim().max(100).allow(''),
    googleProductCategory: Joi.string().trim().max(750).allow(''),
    fbProductCategory: Joi.string().trim().max(750).allow(''),
    productType: Joi.string().trim().max(750).allow(''),
    itemGroupId: Joi.string().trim().max(100).allow(''),
    color: Joi.string().trim().max(200).allow(''),
    size: Joi.string().trim().max(200).allow(''),
    gender: Joi.string().lowercase().valid(...GENDERS).allow(''),
    ageGroup: Joi.string().lowercase().valid(...AGE_GROUPS).allow(''),
    material: Joi.string().trim().max(200).allow(''),
    pattern: Joi.string().trim().max(100).allow(''),
    originCountry: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/)
      .message('originCountry must be a 2-letter ISO country code').allow(''),
    importerName: Joi.string().trim().max(200).allow(''),
    importerAddress: Joi.object({
      street1: Joi.string().trim().max(200).allow(''),
      street2: Joi.string().trim().max(200).allow(''),
      city: Joi.string().trim().max(200).allow(''),
      region: Joi.string().trim().max(200).allow(''),
      postalCode: Joi.string().trim().max(20).allow(''),
      country: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/).allow('')
    }),
    manufacturerInfo: Joi.string().trim().max(1000).allow(''),
    waComplianceCategory: Joi.string().uppercase().valid(...WA_COMPLIANCE_CATEGORIES).allow(''),
    salePriceStart: Joi.date().allow(null, ''),
    salePriceEnd: Joi.date().greater(Joi.ref('salePriceStart'))
      .message('salePriceEnd must be after salePriceStart').allow(null, ''),
    unitPrice: Joi.object({
      value: Joi.number().positive().required(),
      currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/).required(),
      unit: Joi.string().lowercase().valid(...UNIT_PRICE_UNITS).required()
    }),
    shippingWeight: Joi.object({
      value: Joi.number().positive().required(),
      unit: Joi.string().lowercase().valid(...WEIGHT_UNITS).required()
    }),
    videoUrls: Joi.array().items(Joi.string().uri({ scheme: 'https' })).max(MAX_VIDEO_URLS)
  });
}

// ── Payload derivation (shared with the sync service) ─────────────────────────

/**
 * Effective Meta availability: stored override wins, else derived from stock.
 * (stock === 0 → out of stock; null/undefined stock = unlimited → in stock)
 */
function resolveAvailability(product) {
  const override = product?.commerce?.availability;
  if (override && AVAILABILITY_VALUES.includes(override)) return override;
  return product?.stock === 0 ? 'out of stock' : 'in stock';
}

/**
 * Sale-price derivation from discountPercent (no duplicate price storage).
 * @returns {{ salePrice: number, start: Date|null, end: Date|null } | null}
 */
function deriveSalePrice(product) {
  const base = Number(product?.price);
  const discount = Number(product?.discountPercent || 0);
  if (!Number.isFinite(base) || base < 0) return null;
  if (!(discount > 0 && discount <= 100)) return null;

  const salePrice = +(base * (1 - discount / 100)).toFixed(2);
  const start = product?.commerce?.salePriceStart || null;
  const end = product?.commerce?.salePriceEnd || null;
  // Only expose the window when both bounds are valid — Meta requires a range.
  const hasWindow = start && end && new Date(end) > new Date(start);
  return {
    salePrice,
    start: hasWindow ? new Date(start) : null,
    end: hasWindow ? new Date(end) : null
  };
}

module.exports = {
  CONDITIONS,
  AVAILABILITY_VALUES,
  GENDERS,
  AGE_GROUPS,
  WA_COMPLIANCE_CATEGORIES,
  WEIGHT_UNITS,
  UNIT_PRICE_UNITS,
  DEFAULT_CURRENCY,
  MAX_ADDITIONAL_IMAGES,
  MAX_VIDEO_URLS,
  normalizeGtin,
  normalizeAvailability,
  parseShippingWeight,
  coerceCommerceFields,
  buildCommerceJoiSchema,
  resolveAvailability,
  deriveSalePrice
};
