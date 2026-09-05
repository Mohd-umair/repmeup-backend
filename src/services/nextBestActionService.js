'use strict';

const Contact = require('../models/Contact');
const ContactActivity = require('../models/ContactActivity');

function recommend(contact, recentTypes = []) {
  const sentiment = contact.aiInsights?.sentiment;
  const intent = String(contact.aiInsights?.intent || '').toLowerCase();
  const health = contact.intelligence?.healthScore;
  const dnc = contact.communicationPreferences?.doNotContact;

  if (dnc) {
    return { action: 'none', reason: 'This contact asked not to be contacted.' };
  }
  if (intent.includes('payment') || intent.includes('pay')) {
    return { action: 'send_payment_link', reason: 'Customer asked about payment.' };
  }
  if (sentiment === 'negative' && (contact.commerceMetrics?.totalSpent || 0) > 1000) {
    return { action: 'assign_senior_support', reason: 'High-value customer with negative sentiment.' };
  }
  if (recentTypes.includes('campaign_sent') && !recentTypes.includes('campaign_replied')) {
    return { action: 'follow_up_whatsapp', reason: 'Campaign was sent and they have not replied.' };
  }
  if ((health ?? 100) < 40) {
    return { action: 'follow_up_whatsapp', reason: 'Customer health is at risk.' };
  }
  if (contact.lifecycleStage === 'lead' || contact.lifecycleStage === 'engaged') {
    return { action: 'follow_up_whatsapp', reason: 'Lead is still open — a follow-up can convert them.' };
  }
  return { action: 'none', reason: 'No urgent action right now.' };
}

async function computeAndStore(orgId, contactId) {
  const contact = await Contact.findOne({ _id: contactId, organization: orgId, isDeleted: false }).lean();
  if (!contact) return null;
  const recent = await ContactActivity.find({ organization: orgId, contact: contactId })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('type')
    .lean();
  const suggestion = recommend(contact, recent.map((r) => r.type));
  await Contact.updateOne(
    { _id: contactId },
    { $set: { nextBestAction: { ...suggestion, computedAt: new Date() } } }
  );
  return suggestion;
}

module.exports = { recommend, computeAndStore };
