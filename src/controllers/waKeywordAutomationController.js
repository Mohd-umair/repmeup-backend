'use strict';

/**
 * WhatsApp Catalog Keyword Automation Controller
 *
 * Manages the org-level settings for the keyword-triggered product_list auto-response.
 * When `enabled` and an inbound WA message contains one of the configured keywords
 * (e.g. "catalog", "price", "menu"), the bot automatically sends a product_list card
 * — no LLM required. Configured via Automation → Growth in the UI.
 */

const Organization = require('../models/Organization');

exports.getSettings = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.organization._id)
      .select('waKeywordAutomation')
      .lean();

    res.json({
      success: true,
      data: org?.waKeywordAutomation || {
        enabled: false,
        keywords: ['catalog', 'price', 'menu', 'products', 'shop', 'buy', 'order'],
        headerText: 'Our Products',
        bodyText: 'Here are our available products. Tap one to learn more!',
        maxProducts: 10
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const { enabled, keywords, headerText, bodyText, maxProducts } = req.body;

    const update = {};
    if (enabled !== undefined) update['waKeywordAutomation.enabled'] = Boolean(enabled);
    if (Array.isArray(keywords)) {
      update['waKeywordAutomation.keywords'] = keywords
        .map((k) => String(k).toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (headerText !== undefined) update['waKeywordAutomation.headerText'] = String(headerText).trim().substring(0, 60);
    if (bodyText !== undefined) update['waKeywordAutomation.bodyText'] = String(bodyText).trim().substring(0, 160);
    if (maxProducts !== undefined) {
      const n = Math.max(1, Math.min(30, Number(maxProducts)));
      update['waKeywordAutomation.maxProducts'] = n;
    }

    const org = await Organization.findByIdAndUpdate(
      req.user.organization._id,
      { $set: update },
      { new: true, select: 'waKeywordAutomation' }
    );

    res.json({ success: true, data: org?.waKeywordAutomation });
  } catch (err) {
    next(err);
  }
};
