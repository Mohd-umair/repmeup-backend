'use strict';

const ContactActivity = require('../models/ContactActivity');
const Contact = require('../models/Contact');

async function record({
  organization,
  contact,
  type,
  channel = null,
  payload = {},
  actor = { kind: 'system', ref: null },
  relatedCampaign = null,
  relatedOrder = null,
  relatedInteraction = null,
  idempotencyKey = null
}) {
  const activity = {
    organization,
    contact,
    type,
    channel,
    payload,
    actor,
    relatedCampaign,
    relatedOrder,
    relatedInteraction,
    idempotencyKey
  };
  const doc = idempotencyKey
    ? await ContactActivity.findOneAndUpdate(
      { organization, idempotencyKey },
      { $setOnInsert: activity },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
    : await ContactActivity.create(activity);

  if (contact && ['message_in', 'message_out', 'campaign_replied', 'order_placed'].includes(type)) {
    await Contact.updateOne(
      { _id: contact, organization },
      {
        $set: {
          lastInteractionAt: new Date(),
          lastActivityChannel: channel || undefined,
          lastActivityType: type
        }
      }
    );
  }

  return doc;
}

async function listForContact({ orgId, contactId, page = 1, limit = 30 }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip = (pageNum - 1) * limitNum;
  const [items, total] = await Promise.all([
    ContactActivity.find({ organization: orgId, contact: contactId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ContactActivity.countDocuments({ organization: orgId, contact: contactId })
  ]);
  return { items, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } };
}

module.exports = { record, listForContact };
