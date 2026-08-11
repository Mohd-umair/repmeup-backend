const AddOn = require('../models/AddOn');
const AddOnGrant = require('../models/AddOnGrant');
const SubscriptionAddOn = require('../models/SubscriptionAddOn');

/**
 * Super-admin management of the add-on catalogue.
 *
 * SKUs themselves are code-defined (src/config/addOnCatalog.js) and created by
 * `npm run seed:addons` — engineers own what a SKU *is*. What admins own is the
 * commercial configuration: price, how much a unit grants, quantity bounds, and
 * whether it is on sale at all.
 *
 * This is what unblocks `ai_conversations_recharge`: the pricing sheet publishes the
 * ₹1,500–₹2,500 band but not how many conversations that buys, so the SKU ships with
 * `grantAmount: null` and refuses purchase until someone sets it here.
 */

/**
 * @desc    List every add-on with usage counts
 * @route   GET /api/super-admin/addons
 */
exports.listAddOns = async (req, res, next) => {
  try {
    const addOns = await AddOn.find().sort({ displayOrder: 1 }).lean();

    // How much each SKU has actually sold — context for pricing decisions.
    const [grantCounts, activeRecurring] = await Promise.all([
      AddOnGrant.aggregate([
        { $group: { _id: '$addOnId', purchases: { $sum: 1 }, granted: { $sum: '$amount' } } }
      ]),
      SubscriptionAddOn.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$addOnId', subscribers: { $sum: 1 }, units: { $sum: '$quantity' } } }
      ])
    ]);
    const grantsBy = new Map(grantCounts.map((g) => [g._id, g]));
    const recurringBy = new Map(activeRecurring.map((r) => [r._id, r]));

    const items = addOns.map((a) => ({
      ...a,
      /** Rows an admin still has to configure before the SKU can be sold. */
      unconfiguredPlanIds: (a.pricing || [])
        .filter((p) => p.grantAmount == null && a.grant?.mode !== 'boolean_grant')
        .map((p) => p.planId),
      stats: {
        purchases: grantsBy.get(a.addOnId)?.purchases || 0,
        granted: grantsBy.get(a.addOnId)?.granted || 0,
        subscribers: recurringBy.get(a.addOnId)?.subscribers || 0,
        units: recurringBy.get(a.addOnId)?.units || 0
      }
    }));

    res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Update an add-on's commercial configuration
 * @route   PUT /api/super-admin/addons/:addOnId
 *
 * Deliberately narrow: `addOnId`, `kind` and `grant` are code-owned and cannot be
 * edited here, because changing what a SKU grants would silently rewrite the meaning
 * of purchases already in the ledger.
 */
exports.updateAddOn = async (req, res, next) => {
  try {
    const addOn = await AddOn.findOne({ addOnId: req.params.addOnId });
    if (!addOn) {
      return res.status(404).json({ success: false, error: 'Add-on not found' });
    }

    const { name, description, isActive, isPublic, displayOrder, pricing } = req.body;

    if (name !== undefined) addOn.name = String(name).trim();
    if (description !== undefined) addOn.description = String(description).trim();
    if (isActive !== undefined) addOn.isActive = !!isActive;
    if (isPublic !== undefined) addOn.isPublic = !!isPublic;
    if (displayOrder !== undefined) addOn.displayOrder = Number(displayOrder) || 0;

    if (Array.isArray(pricing)) {
      const cleaned = [];
      for (const row of pricing) {
        if (!row?.planId) continue;
        const priceInr = Number(row.priceInr);
        if (!Number.isFinite(priceInr) || priceInr < 0) {
          return res.status(400).json({
            success: false,
            error: `Invalid price for plan "${row.planId}".`
          });
        }
        const grantAmount = row.grantAmount === null || row.grantAmount === undefined || row.grantAmount === ''
          ? null
          : Number(row.grantAmount);
        if (grantAmount !== null && (!Number.isFinite(grantAmount) || grantAmount <= 0)) {
          return res.status(400).json({
            success: false,
            error: `Grant amount for plan "${row.planId}" must be a positive number.`
          });
        }
        const minQuantity = Math.max(1, Number(row.minQuantity) || 1);
        const maxQuantity = Math.max(minQuantity, Number(row.maxQuantity) || minQuantity);

        cleaned.push({
          planId: String(row.planId).toLowerCase().trim(),
          priceInr,
          grantAmount,
          minQuantity,
          maxQuantity,
          minPriceInr: row.minPriceInr == null ? null : Number(row.minPriceInr),
          maxPriceInr: row.maxPriceInr == null ? null : Number(row.maxPriceInr),
          razorpayPlanId: row.razorpayPlanId || null
        });
      }
      addOn.pricing = cleaned;
    }

    await addOn.save();
    res.json({ success: true, data: addOn.toObject(), message: 'Add-on updated' });
  } catch (err) {
    next(err);
  }
};
