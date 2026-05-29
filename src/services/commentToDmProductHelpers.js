'use strict';

/**
 * Shared helpers for Instagram comment-to-DM product resolution and DM payloads.
 */

const MAX_PICKER_ELEMENTS = 10;
const MAX_LABEL = 20;
const MAX_TITLE = 80;

/**
 * Mongo filter: products linked to an Instagram post (numeric id, shortcode, or instagramPostLinks).
 */
function buildPostLinkedProductQuery(organizationId, postId) {
  const pid = String(postId);
  return {
    organization: organizationId,
    isActive: true,
    $or: [
      { instagramPostIds: pid },
      { 'instagramPostLinks.postId': pid }
    ]
  };
}

function mergeProductsById(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const p of list || []) {
      const id = String(p._id);
      if (p?._id && !map.has(id)) map.set(id, p);
    }
  }
  return [...map.values()];
}

/**
 * Sort products linked to the same post (carousel slide order / sortOrder / name).
 */
function sortProductsForPost(products, postId) {
  const pid = String(postId);
  return [...products].sort((a, b) => {
    const linkA = (a.instagramPostLinks || []).find(l => String(l.postId) === pid);
    const linkB = (b.instagramPostLinks || []).find(l => String(l.postId) === pid);
    const orderA = linkA?.sortOrder ?? linkA?.slideIndex ?? 9999;
    const orderB = linkB?.sortOrder ?? linkB?.slideIndex ?? 9999;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/**
 * If comment text uniquely identifies one product, return it; else null.
 */
function matchProductByCommentText(products, commentText) {
  const text = String(commentText || '').toLowerCase().trim();
  if (!text) return null;

  const matches = products.filter((p) => {
    const name = String(p.name || '').toLowerCase().trim();
    if (name.length >= 3 && text.includes(name)) return true;
    const sku = String(p.sku || '').toLowerCase().trim();
    if (sku.length >= 2 && text.includes(sku)) return true;
    const kws = p.dmConfig?.triggerKeywords || [];
    if (kws.some(kw => {
      const k = String(kw || '').toLowerCase().trim();
      return k.length >= 2 && text.includes(k);
    })) return true;
    return false;
  });

  return matches.length === 1 ? matches[0] : null;
}

function formatProductPrice(product) {
  const currency = product.currency || 'AED';
  const price = product.effectivePrice != null ? product.effectivePrice : product.price;
  if (price == null) return currency;
  return `${currency} ${price}`;
}

function productImageUrl(product) {
  const img = product.images?.[0] || product.imageUrl || '';
  const url = String(img).trim();
  return /^https:\/\//i.test(url) ? url : '';
}

/**
 * Build Generic Template elements for product picker (max 10).
 * Uses per-product dmConfig CTA buttons when configured; falls back to Select/PICK.
 */
function buildProductPickerElements(products, selectionToken, sfSettings = {}, orderTokensByProductId = {}) {
  const list = products.slice(0, MAX_PICKER_ELEMENTS);
  return list.map((p) => {
    const productId = String(p._id);
    const effectiveDmConfig = buildEffectiveDmConfig(p, sfSettings);
    const orderToken = orderTokensByProductId[productId];
    const paymentUrlWithToken = p.paymentUrl && orderToken
      ? `${p.paymentUrl}${p.paymentUrl.includes('?') ? '&' : '?'}ref=${orderToken}`
      : '';
    const ctaButtons = orderToken
      ? buildCtaButtons(effectiveDmConfig, orderToken, paymentUrlWithToken)
      : [];

    const element = {
      title: String(effectiveDmConfig.ctaTitle || p.name || 'Product').slice(0, MAX_TITLE),
      subtitle: String(effectiveDmConfig.ctaSubtitle || formatProductPrice(p)).slice(0, MAX_TITLE),
      buttons: ctaButtons.length
        ? ctaButtons
        : [{
          type: 'postback',
          title: 'Select',
          payload: `PICK:${p._id}:${selectionToken}`
        }]
    };

    const imgUrl = String(effectiveDmConfig.ctaImageUrl || productImageUrl(p)).trim();
    if (imgUrl && /^https:\/\//i.test(imgUrl)) {
      element.image_url = imgUrl;
    }

    return element;
  });
}

/**
 * Numbered text fallback when >10 products on one post.
 */
function buildNumberedPickerText(products, commenterUsername) {
  const hi = commenterUsername ? `@${commenterUsername}` : 'there';
  const lines = [`Hi ${hi}! 👋 Which product are you interested in? Reply with the number:`];
  products.slice(0, 20).forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name} — ${formatProductPrice(p)}`);
  });
  return lines.join('\n');
}

/**
 * Merge per-product dmConfig over org salesFlowSettings.
 */
function buildEffectiveDmConfig(product, sfSettings) {
  const pdc = product?.dmConfig || {};
  const sf = sfSettings || {};
  return {
    ctaTitle: pdc.ctaTitle || sf.ctaTitle || '',
    ctaSubtitle: pdc.ctaSubtitle || sf.ctaSubtitle || '',
    ctaImageUrl: pdc.ctaImageUrl || sf.ctaImageUrl || '',
    ctaButtons: (pdc.ctaButtons?.length ? pdc.ctaButtons : sf.ctaButtons) || [],
    hesitancyKeywords: (pdc.hesitancyKeywords?.length ? pdc.hesitancyKeywords : sf.hesitancyKeywords) || [],
    whatsappCaptureMessage: pdc.whatsappCaptureMessage || sf.whatsappCaptureMessage || '',
    whatsappCaptureConfirmation: pdc.whatsappCaptureConfirmation || sf.whatsappCaptureConfirmation || ''
  };
}

/**
 * Build CTA buttons array for Generic Template (postback embeds orderToken).
 */
function buildCtaButtons(effectiveDmConfig, orderToken, paymentUrlWithToken) {
  const rawButtons = Array.isArray(effectiveDmConfig.ctaButtons) ? effectiveDmConfig.ctaButtons : [];
  const buttons = [];

  for (const btn of rawButtons) {
    if (buttons.length >= 3) break;
    const label = String(btn.label || '').trim();
    if (!label) continue;
    const type = btn.type === 'web_url' ? 'web_url' : 'postback';

    if (type === 'web_url') {
      let url = String(btn.url || '').replace(/\{\{orderToken\}\}/g, orderToken).trim();
      if (!url && /pay/i.test(label) && paymentUrlWithToken) url = paymentUrlWithToken;
      if (!/^https:\/\//i.test(url)) continue;
      buttons.push({ type: 'web_url', url, title: label.slice(0, MAX_LABEL) });
    } else {
      const payload = String(btn.payload || '').trim() || label.toLowerCase();
      buttons.push({
        type: 'postback',
        title: label.slice(0, MAX_LABEL),
        payload: `SALES:${payload}:${orderToken}`
      });
    }
  }

  return buttons;
}

/**
 * Build single-product CTA Generic Template element.
 */
function buildProductCtaElement(product, effectiveDmConfig, orderToken, paymentUrlWithToken) {
  const buttons = buildCtaButtons(effectiveDmConfig, orderToken, paymentUrlWithToken);
  if (!buttons.length) return null;

  const element = {
    title: String(effectiveDmConfig.ctaTitle || `🛍️ ${product.name}`).slice(0, MAX_TITLE),
    buttons
  };
  const subtitle = String(effectiveDmConfig.ctaSubtitle || 'Tap a button below to continue 👇').slice(0, MAX_TITLE);
  if (subtitle) element.subtitle = subtitle;
  const imgUrl = String(effectiveDmConfig.ctaImageUrl || productImageUrl(product)).trim();
  if (imgUrl && /^https:\/\//i.test(imgUrl)) element.image_url = imgUrl;
  return element;
}

function filterProductsByPerProductKeywords(products, commentText) {
  const text = String(commentText || '').toLowerCase();
  return products.filter((p) => {
    const kws = p.dmConfig?.triggerKeywords;
    if (!kws?.length) return true;
    const productKws = kws.map(k => String(k).toLowerCase().trim()).filter(Boolean);
    return productKws.some(kw => text.includes(kw));
  });
}

module.exports = {
  MAX_PICKER_ELEMENTS,
  buildPostLinkedProductQuery,
  mergeProductsById,
  sortProductsForPost,
  matchProductByCommentText,
  formatProductPrice,
  productImageUrl,
  buildProductPickerElements,
  buildNumberedPickerText,
  buildEffectiveDmConfig,
  buildCtaButtons,
  buildProductCtaElement,
  filterProductsByPerProductKeywords
};
