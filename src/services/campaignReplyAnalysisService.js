'use strict';

const Campaign = require('../models/Campaign');
const ContactActivity = require('../models/ContactActivity');
const Interaction = require('../models/Interaction');

const INTENT_KEYS = ['purchase', 'payment', 'product_inquiry', 'support', 'complaint', 'not_interested', 'spam', 'other'];

function mapIntent(raw) {
  const v = String(raw || '').toLowerCase();
  if (v.includes('pay')) return 'payment';
  if (v.includes('purchase') || v.includes('buy')) return 'purchase';
  if (v.includes('product') || v.includes('inquiry')) return 'product_inquiry';
  if (v.includes('complaint')) return 'complaint';
  if (v.includes('support')) return 'support';
  if (v.includes('spam')) return 'spam';
  if (v.includes('not') && v.includes('interest')) return 'not_interested';
  return 'other';
}

async function analyzeCampaign(orgId, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });

  const replies = await ContactActivity.find({
    organization: orgId,
    relatedCampaign: campaignId,
    type: 'campaign_replied'
  }).select('payload relatedInteraction').limit(2000).lean();

  const interactionIds = replies
    .map((row) => row.relatedInteraction)
    .filter(Boolean);
  const interactions = interactionIds.length
    ? await Interaction.find({
      _id: { $in: interactionIds },
      organization: orgId
    }).select('intent sentiment').lean()
    : [];
  const byInteraction = new Map(interactions.map((row) => [String(row._id), row]));

  const counts = Object.fromEntries(INTENT_KEYS.map((k) => [k, 0]));
  let positive = 0;
  let negative = 0;

  for (const row of replies) {
    const interaction = row.relatedInteraction
      ? byInteraction.get(String(row.relatedInteraction))
      : null;
    const intent = row.payload?.intent || interaction?.intent;
    const sentiment = row.payload?.sentiment || interaction?.sentiment;
    counts[mapIntent(intent)] += 1;
    if (sentiment === 'positive') positive += 1;
    if (sentiment === 'negative') negative += 1;
  }

  campaign.stats.intents = counts;
  campaign.stats.positive = positive;
  campaign.stats.negative = negative;
  campaign.stats.replied = replies.length;
  await campaign.save();
  return { intents: counts, positive, negative, replied: replies.length };
}

module.exports = { analyzeCampaign, mapIntent };
