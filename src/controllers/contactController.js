const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const logger = require('../config/logger');

function orgIdOf(req) {
  return req.user.organization?._id || req.user.organization;
}

// ─── List contacts ─────────────────────────────────────────────────────────
// GET /api/contacts?search=&platform=&tag=&page=1&limit=20
exports.getContacts = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const { search, platform, tag, page = 1, limit = 20 } = req.query;

    const query = { organization: orgId, isDeleted: false };

    if (platform) {
      query['channels.platform'] = platform;
    }

    if (tag) {
      query.tags = tag;
    }

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [
        { primaryName: regex },
        { primaryPhone: regex },
        { primaryEmail: regex },
        { 'channels.username': regex }
      ];
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort({ lastInteractionAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Contact.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      data: contacts,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('getContacts error', { error: error.message });
    next(error);
  }
};

// ─── Get single contact with interactions ─────────────────────────────────
// GET /api/contacts/:id
exports.getContact = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);

    const contact = await Contact.findOne({
      _id: req.params.id,
      organization: orgId,
      isDeleted: false
    }).populate('owner', 'firstName lastName email').lean();

    if (!contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    // Fetch last 20 interactions for this contact
    const interactions = await Interaction.find({
      contact: contact._id,
      organization: orgId
    })
      .select('platform type content status platformCreatedAt respondedAt chatRef chatNumber author.name author.avatarUrl replies')
      .sort({ platformCreatedAt: -1 })
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,
      data: { ...contact, interactions }
    });
  } catch (error) {
    logger.error('getContact error', { error: error.message });
    next(error);
  }
};

// ─── Update contact ────────────────────────────────────────────────────────
// PUT /api/contacts/:id
exports.updateContact = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const { primaryName, primaryPhone, primaryEmail, notes, tags } = req.body;

    const contact = await Contact.findOne({ _id: req.params.id, organization: orgId, isDeleted: false });
    if (!contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    if (primaryName !== undefined) contact.primaryName = primaryName.trim() || contact.primaryName;
    if (primaryPhone !== undefined) contact.primaryPhone = primaryPhone?.trim() || null;
    if (primaryEmail !== undefined) contact.primaryEmail = primaryEmail?.trim()?.toLowerCase() || null;
    if (notes !== undefined) contact.notes = notes?.trim() || null;
    if (Array.isArray(tags)) contact.tags = tags.map(t => t.trim()).filter(Boolean);

    contact.updatedAt = new Date();
    await contact.save();

    return res.status(200).json({ success: true, data: contact });
  } catch (error) {
    logger.error('updateContact error', { error: error.message });
    next(error);
  }
};

// ─── Soft delete contact ────────────────────────────────────────────────────
// DELETE /api/contacts/:id
exports.deleteContact = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);

    const contact = await Contact.findOne({ _id: req.params.id, organization: orgId, isDeleted: false });
    if (!contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    contact.isDeleted = true;
    contact.updatedAt = new Date();
    await contact.save();

    return res.status(200).json({ success: true, message: 'Contact deleted' });
  } catch (error) {
    logger.error('deleteContact error', { error: error.message });
    next(error);
  }
};

// ─── Merge contacts ─────────────────────────────────────────────────────────
// POST /api/contacts/:id/merge  body: { phone } or { email }
// Merges target contact (found by phone or email) INTO :id (primary). Target becomes deleted.
exports.mergeContact = async (req, res, next) => {
  try {
    const orgId = orgIdOf(req);
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ success: false, error: 'A phone number or email is required to find the contact to merge.' });
    }

    // Build lookup query — phone takes priority
    const targetQuery = { organization: orgId, isDeleted: false };
    if (phone) {
      targetQuery.primaryPhone = phone.trim();
    } else {
      targetQuery.primaryEmail = email.trim().toLowerCase();
    }

    const [primary, target] = await Promise.all([
      Contact.findOne({ _id: req.params.id, organization: orgId, isDeleted: false }),
      Contact.findOne(targetQuery)
    ]);

    if (!primary) return res.status(404).json({ success: false, error: 'Primary contact not found' });
    if (!target) {
      const field = phone ? 'phone number' : 'email';
      return res.status(404).json({ success: false, error: `No contact found with that ${field}.` });
    }
    if (String(target._id) === String(primary._id)) {
      return res.status(400).json({ success: false, error: 'That contact is the same as the current one.' });
    }

    // Merge channels — add unique channels from target into primary
    for (const ch of target.channels) {
      const exists = primary.channels.some(
        c => c.platform === ch.platform && String(c.platformUserId) === String(ch.platformUserId)
      );
      if (!exists) primary.channels.push(ch);
    }

    // Merge tags
    const tagSet = new Set([...(primary.tags || []), ...(target.tags || [])]);
    primary.tags = Array.from(tagSet);

    // Enrich primary fields from target
    if (!primary.primaryPhone && target.primaryPhone) primary.primaryPhone = target.primaryPhone;
    if (!primary.primaryEmail && target.primaryEmail) primary.primaryEmail = target.primaryEmail;
    if (primary.primaryName === 'Unknown' && target.primaryName !== 'Unknown') {
      primary.primaryName = target.primaryName;
    }
    if (!primary.notes && target.notes) primary.notes = target.notes;

    primary.updatedAt = new Date();

    // Re-point all target's interactions to primary
    await Interaction.updateMany({ contact: target._id }, { $set: { contact: primary._id } });

    // Soft-delete the target
    target.isDeleted = true;
    target.updatedAt = new Date();

    await Promise.all([primary.save(), target.save()]);

    return res.status(200).json({ success: true, data: primary });
  } catch (error) {
    logger.error('mergeContact error', { error: error.message });
    next(error);
  }
};

/**
 * PATCH /contacts/:id/flow-opt-out
 * Manually toggle a contact's automated flow opt-out status.
 * Body: { optedOut: boolean }
 */
exports.toggleFlowOptOut = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { optedOut } = req.body;
    if (typeof optedOut !== 'boolean') {
      return res.status(400).json({ success: false, error: '`optedOut` must be a boolean.' });
    }

    const contact = await Contact.findOneAndUpdate(
      { _id: id, organization: req.user.organization, isDeleted: false },
      optedOut
        ? { flowsOptedOut: true,  flowsOptedOutAt: new Date() }
        : { flowsOptedOut: false, flowsOptedOutAt: null },
      { new: true, select: '_id primaryName flowsOptedOut flowsOptedOutAt' }
    );
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found.' });

    return res.json({ success: true, data: contact });
  } catch (error) {
    logger.error('toggleFlowOptOut error', { error: error.message });
    next(error);
  }
};
