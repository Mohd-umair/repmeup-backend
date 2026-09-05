'use strict';

const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const ContactActivity = require('../models/ContactActivity');
const openaiClient = require('./ai/openaiClient');
const { completionTextFromOpenAIResponse } = require('../utils/openaiModelHelpers');

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function recencyPoints(lastAt) {
  if (!lastAt) return 0;
  const days = (Date.now() - new Date(lastAt).getTime()) / 86400000;
  if (days <= 1) return 25;
  if (days <= 7) return 20;
  if (days <= 30) return 12;
  if (days <= 90) return 5;
  return 0;
}

function bandFromHealth(score) {
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'needs_attention';
  return 'at_risk';
}

function churnFromHealth(score) {
  if (score >= 70) return 'low';
  if (score >= 40) return 'medium';
  return 'high';
}

async function computeForContact(orgId, contactId) {
  const contact = await Contact.findOne({ _id: contactId, organization: orgId, isDeleted: false }).lean();
  if (!contact) return null;

  const since = new Date(Date.now() - 90 * 86400000);
  const [recent, replies, negatives, campaignReplies] = await Promise.all([
    Interaction.countDocuments({ organization: orgId, contact: contactId, platformCreatedAt: { $gte: since } }),
    Interaction.countDocuments({ organization: orgId, contact: contactId, status: 'replied', platformCreatedAt: { $gte: since } }),
    Interaction.countDocuments({ organization: orgId, contact: contactId, sentiment: 'negative', platformCreatedAt: { $gte: since } }),
    ContactActivity.countDocuments({ organization: orgId, contact: contactId, type: 'campaign_replied', createdAt: { $gte: since } })
  ]);

  const recency = recencyPoints(contact.lastInteractionAt);
  const engagement = clamp(recent * 4 + replies * 6 + campaignReplies * 5, 0, 35);
  const commerce = clamp((contact.commerceMetrics?.totalOrders || 0) * 4 + Math.min(15, (contact.commerceMetrics?.totalSpent || 0) / 200), 0, 25);
  const sentimentPenalty = negatives * 6;
  const healthScore = clamp(Math.round(recency + engagement + commerce - sentimentPenalty + 15), 0, 100);
  const leadScore = clamp(Math.round(engagement + recency + (contact.lifecycleStage === 'qualified' ? 15 : 0) + (contact.lifecycleStage === 'customer' ? 10 : 0)), 0, 100);
  const engagementScore = clamp(Math.round(engagement + recency), 0, 100);

  const latest = await Interaction.findOne({ organization: orgId, contact: contactId, sentiment: { $ne: null } })
    .sort({ platformCreatedAt: -1 })
    .select('sentiment intent')
    .lean();

  const patch = {
    'intelligence.healthScore': healthScore,
    'intelligence.healthBand': bandFromHealth(healthScore),
    'intelligence.leadScore': leadScore,
    'intelligence.churnRisk': churnFromHealth(healthScore),
    'intelligence.engagementScore': engagementScore,
    'intelligence.computedAt': new Date()
  };
  if (latest?.sentiment) patch['aiInsights.sentiment'] = latest.sentiment;
  const { sanitizeAiIntent } = require('../utils/aiInsightsDisplay');
  const intent = sanitizeAiIntent(latest?.intent);
  if (intent) patch['aiInsights.intent'] = intent;

  await Contact.updateOne({ _id: contactId, organization: orgId, isDeleted: false }, { $set: patch });
  return { healthScore, leadScore, engagementScore, healthBand: patch['intelligence.healthBand'], churnRisk: patch['intelligence.churnRisk'] };
}

async function generateSummary(orgId, contactId) {
  const contact = await Contact.findOne({ _id: contactId, organization: orgId, isDeleted: false }).lean();
  if (!contact) return null;
  const interactions = await Interaction.find({ organization: orgId, contact: contactId })
    .select('platform content sentiment intent platformCreatedAt')
    .sort({ platformCreatedAt: -1 })
    .limit(12)
    .lean();

  const transcript = interactions.map((i) => `[${i.platform}] ${i.content || ''}`).join('\n').slice(0, 4000);
  let summary = `${contact.primaryName} has ${interactions.length} recent conversations.`;
  try {
    if (openaiClient.hasApiKey()) {
      const response = await openaiClient.chatCompletion({
        model: openaiClient.classificationModel,
        max_tokens: 180,
        messages: [
          { role: 'system', content: 'Summarize this customer in 2-3 sentences for a shop owner. Mention intent and sentiment if clear. No secrets.' },
          { role: 'user', content: `Name: ${contact.primaryName}\nLifecycle: ${contact.lifecycleStage}\nOrders: ${contact.commerceMetrics?.totalOrders || 0}\nSpent: ${contact.commerceMetrics?.totalSpent || 0}\nMessages:\n${transcript}` }
        ]
      }, { organizationId: orgId, feature: 'contact.summary' });
      const text = completionTextFromOpenAIResponse(response.data);
      if (text) summary = text;
    }
  } catch {
    /* keep fallback */
  }

  await Contact.updateOne(
    { _id: contactId, organization: orgId, isDeleted: false },
    { $set: { 'intelligence.aiSummary': summary, 'intelligence.aiConfidence': 0.8, 'intelligence.computedAt': new Date() } }
  );
  return summary;
}

async function recomputeOrg(orgId, limit = 200) {
  const contacts = await Contact.find({ organization: orgId, isDeleted: false })
    .select('_id')
    .sort({ lastInteractionAt: -1 })
    .limit(limit)
    .lean();
  let done = 0;
  for (const c of contacts) {
    await computeForContact(orgId, c._id);
    done += 1;
  }
  return { done };
}

module.exports = { computeForContact, generateSummary, recomputeOrg };
