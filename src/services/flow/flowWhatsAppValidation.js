'use strict';

/**
 * Semantic validation for WhatsApp interactive message nodes.
 *
 * The generic flow validator only checks `required` presence. WhatsApp's Cloud
 * API enforces strict structural and length limits per interactive type — a
 * payload that violates them is rejected by Meta at send time (error 100 /
 * 131009). We validate those limits here at author time so the flow can never
 * be published in a state Meta will reject.
 *
 * Meta references:
 *   - Interactive list:    max 10 rows total, ≤10 sections, button ≤20 chars,
 *                          row title ≤24, row description ≤72, section title ≤24
 *   - Reply buttons:       1–3 buttons, button title ≤20 chars, unique ids
 *   - Product list:        max 30 products total, header required
 *   - Media:               https URL required; caption only for image/video/document
 *   - Location:            valid lat (-90..90) / lng (-180..180)
 */

const LIMITS = {
  bodyText: 1024,
  listBodyText: 4096,
  headerText: 60,
  footerText: 60,
  caption: 1024,
  listButtonText: 20,
  replyButtonTitle: 20,
  replyButtonsMax: 3,
  listRowTitle: 24,
  listRowDescription: 72,
  listSectionTitle: 24,
  listRowsMax: 10,
  listSectionsMax: 10,
  productTotalMax: 30
};

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];
const CAPTIONABLE = ['image', 'video', 'document'];

const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => str(v).trim();
const len = (v) => str(v).length;

function isHttpsUrl(value) {
  const v = trimmed(value);
  if (!/^https:\/\//i.test(v)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate one WhatsApp interactive node.
 * @returns {Array<{ field?: string, message: string }>} per-node issues (empty if valid)
 */
function validateWhatsAppNode(node) {
  const config = node?.config || {};
  switch (node?.type) {
    case 'action.send_media':
      return validateMedia(config);
    case 'action.send_location':
      return validateLocation(config);
    case 'action.send_buttons':
      return validateButtons(config);
    case 'action.send_list':
      return validateList(config);
    case 'action.send_product':
      return validateProduct(config);
    case 'action.send_product_list':
      return validateProductList(config);
    case 'action.send_catalog':
      return validateCatalog(config);
    default:
      return [];
  }
}

function validateMedia(config) {
  const issues = [];
  const mediaType = trimmed(config.mediaType) || 'image';

  if (!MEDIA_TYPES.includes(mediaType)) {
    issues.push({ field: 'mediaType', message: `Media type must be one of: ${MEDIA_TYPES.join(', ')}.` });
  }
  if (!isHttpsUrl(config.mediaUrl)) {
    issues.push({ field: 'mediaUrl', message: 'Media URL must be a valid https:// link reachable by Meta.' });
  }
  if (trimmed(config.caption)) {
    if (!CAPTIONABLE.includes(mediaType)) {
      issues.push({ field: 'caption', message: `Captions are only supported for image, video, and document — not ${mediaType}.` });
    } else if (len(config.caption) > LIMITS.caption) {
      issues.push({ field: 'caption', message: `Caption must be ${LIMITS.caption} characters or fewer.` });
    }
  }
  if (mediaType === 'document' && trimmed(config.filename) && len(config.filename) > 240) {
    issues.push({ field: 'filename', message: 'Document filename is too long (max 240 characters).' });
  }
  return issues;
}

function validateLocation(config) {
  const issues = [];
  const lat = Number(config.latitude);
  const lng = Number(config.longitude);

  if (!trimmed(config.latitude) || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    issues.push({ field: 'latitude', message: 'Latitude must be a number between -90 and 90.' });
  }
  if (!trimmed(config.longitude) || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    issues.push({ field: 'longitude', message: 'Longitude must be a number between -180 and 180.' });
  }
  if (trimmed(config.address) && !trimmed(config.name)) {
    issues.push({ field: 'name', message: 'A location name is required when an address is provided.' });
  }
  return issues;
}

function validateButtons(config) {
  const issues = [];

  if (!trimmed(config.bodyText)) {
    issues.push({ field: 'bodyText', message: 'Body text is required.' });
  } else if (len(config.bodyText) > LIMITS.bodyText) {
    issues.push({ field: 'bodyText', message: `Body text must be ${LIMITS.bodyText} characters or fewer.` });
  }
  if (len(config.headerText) > LIMITS.headerText) {
    issues.push({ field: 'headerText', message: `Header must be ${LIMITS.headerText} characters or fewer.` });
  }
  if (len(config.footerText) > LIMITS.footerText) {
    issues.push({ field: 'footerText', message: `Footer must be ${LIMITS.footerText} characters or fewer.` });
  }

  const buttons = Array.isArray(config.buttons) ? config.buttons : [];
  if (buttons.length < 1) {
    issues.push({ field: 'buttons', message: 'Add at least one reply button.' });
  }
  if (buttons.length > LIMITS.replyButtonsMax) {
    issues.push({ field: 'buttons', message: `WhatsApp allows at most ${LIMITS.replyButtonsMax} reply buttons.` });
  }

  const seenIds = new Set();
  buttons.forEach((btn, i) => {
    const title = trimmed(btn?.title);
    const id = trimmed(btn?.id);
    if (!title) {
      issues.push({ field: 'buttons', message: `Button ${i + 1}: title is required.` });
    } else if (len(title) > LIMITS.replyButtonTitle) {
      issues.push({ field: 'buttons', message: `Button ${i + 1}: title must be ${LIMITS.replyButtonTitle} characters or fewer.` });
    }
    if (!id) {
      issues.push({ field: 'buttons', message: `Button ${i + 1}: id is required.` });
    } else if (seenIds.has(id.toLowerCase())) {
      issues.push({ field: 'buttons', message: `Button ${i + 1}: id "${id}" is duplicated — ids must be unique.` });
    } else {
      seenIds.add(id.toLowerCase());
    }
  });

  return issues;
}

function validateList(config) {
  const issues = [];

  if (!trimmed(config.bodyText)) {
    issues.push({ field: 'bodyText', message: 'Body text is required.' });
  } else if (len(config.bodyText) > LIMITS.listBodyText) {
    issues.push({ field: 'bodyText', message: `Body text must be ${LIMITS.listBodyText} characters or fewer.` });
  }
  if (!trimmed(config.buttonText)) {
    issues.push({ field: 'buttonText', message: 'List button text is required.' });
  } else if (len(config.buttonText) > LIMITS.listButtonText) {
    issues.push({ field: 'buttonText', message: `List button text must be ${LIMITS.listButtonText} characters or fewer.` });
  }
  if (len(config.headerText) > LIMITS.headerText) {
    issues.push({ field: 'headerText', message: `Header must be ${LIMITS.headerText} characters or fewer.` });
  }
  if (len(config.footerText) > LIMITS.footerText) {
    issues.push({ field: 'footerText', message: `Footer must be ${LIMITS.footerText} characters or fewer.` });
  }

  const sections = Array.isArray(config.sections) ? config.sections : [];
  if (!sections.length) {
    issues.push({ field: 'sections', message: 'Add at least one section with one row.' });
  }
  if (sections.length > LIMITS.listSectionsMax) {
    issues.push({ field: 'sections', message: `A list can have at most ${LIMITS.listSectionsMax} sections.` });
  }

  let totalRows = 0;
  const seenRowIds = new Set();
  sections.forEach((section, si) => {
    if (len(section?.title) > LIMITS.listSectionTitle) {
      issues.push({ field: 'sections', message: `Section ${si + 1}: title must be ${LIMITS.listSectionTitle} characters or fewer.` });
    }
    const rows = Array.isArray(section?.rows) ? section.rows : [];
    if (!rows.length) {
      issues.push({ field: 'sections', message: `Section ${si + 1}: add at least one row.` });
    }
    rows.forEach((row, ri) => {
      totalRows += 1;
      const title = trimmed(row?.title);
      const id = trimmed(row?.id);
      if (!title) {
        issues.push({ field: 'sections', message: `Section ${si + 1}, row ${ri + 1}: title is required.` });
      } else if (len(title) > LIMITS.listRowTitle) {
        issues.push({ field: 'sections', message: `Section ${si + 1}, row ${ri + 1}: title must be ${LIMITS.listRowTitle} characters or fewer.` });
      }
      if (len(row?.description) > LIMITS.listRowDescription) {
        issues.push({ field: 'sections', message: `Section ${si + 1}, row ${ri + 1}: description must be ${LIMITS.listRowDescription} characters or fewer.` });
      }
      if (!id) {
        issues.push({ field: 'sections', message: `Section ${si + 1}, row ${ri + 1}: id is required.` });
      } else if (seenRowIds.has(id.toLowerCase())) {
        issues.push({ field: 'sections', message: `Row id "${id}" is duplicated — every row id must be unique across the list.` });
      } else {
        seenRowIds.add(id.toLowerCase());
      }
    });
  });

  if (totalRows > LIMITS.listRowsMax) {
    issues.push({ field: 'sections', message: `A list can have at most ${LIMITS.listRowsMax} rows in total (currently ${totalRows}).` });
  }

  return issues;
}

function validateProduct(config) {
  const issues = [];
  if (!trimmed(config.productId)) {
    issues.push({ field: 'productId', message: 'Select a product to send.' });
  }
  if (len(config.bodyText) > LIMITS.caption) {
    issues.push({ field: 'bodyText', message: `Message must be ${LIMITS.caption} characters or fewer.` });
  }
  return issues;
}

function validateProductList(config) {
  const issues = [];

  if (!trimmed(config.headerText)) {
    issues.push({ field: 'headerText', message: 'A header is required for product list messages.' });
  } else if (len(config.headerText) > LIMITS.headerText) {
    issues.push({ field: 'headerText', message: `Header must be ${LIMITS.headerText} characters or fewer.` });
  }
  if (!trimmed(config.bodyText)) {
    issues.push({ field: 'bodyText', message: 'Body text is required.' });
  } else if (len(config.bodyText) > LIMITS.caption) {
    issues.push({ field: 'bodyText', message: `Body text must be ${LIMITS.caption} characters or fewer.` });
  }
  if (len(config.footerText) > LIMITS.footerText) {
    issues.push({ field: 'footerText', message: `Footer must be ${LIMITS.footerText} characters or fewer.` });
  }

  const sections = Array.isArray(config.productSections) ? config.productSections : [];
  if (!sections.length) {
    issues.push({ field: 'productSections', message: 'Add at least one section with at least one product.' });
  }

  let totalProducts = 0;
  sections.forEach((section, si) => {
    if (!trimmed(section?.title)) {
      issues.push({ field: 'productSections', message: `Section ${si + 1}: a title is required.` });
    } else if (len(section.title) > LIMITS.listSectionTitle) {
      issues.push({ field: 'productSections', message: `Section ${si + 1}: title must be ${LIMITS.listSectionTitle} characters or fewer.` });
    }
    const ids = Array.isArray(section?.productIds) ? section.productIds.filter((p) => trimmed(p)) : [];
    if (!ids.length) {
      issues.push({ field: 'productSections', message: `Section ${si + 1}: add at least one product.` });
    }
    totalProducts += ids.length;
  });

  if (totalProducts > LIMITS.productTotalMax) {
    issues.push({ field: 'productSections', message: `A multi-product message can include at most ${LIMITS.productTotalMax} products (currently ${totalProducts}).` });
  }

  return issues;
}

function validateCatalog(config) {
  const issues = [];
  if (!trimmed(config.bodyText)) {
    issues.push({ field: 'bodyText', message: 'Body text is required.' });
  } else if (len(config.bodyText) > LIMITS.caption) {
    issues.push({ field: 'bodyText', message: `Body text must be ${LIMITS.caption} characters or fewer.` });
  }
  if (len(config.footerText) > LIMITS.footerText) {
    issues.push({ field: 'footerText', message: `Footer must be ${LIMITS.footerText} characters or fewer.` });
  }
  // thumbnailProductId is optional — Meta defaults to the first catalog item.
  return issues;
}

module.exports = { validateWhatsAppNode, LIMITS };
