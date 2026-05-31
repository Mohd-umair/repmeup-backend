'use strict';

const Interaction = require('../../models/Interaction');
const ReviewRequest = require('../../models/ReviewRequest');
const { generateOpsRef } = require('../../utils/opsRefHelper');
const {
  CHANNEL_LABELS,
  formatDateLabel,
  customerFromInteraction,
  getReviewRating,
  reviewSnippet,
  chatDeepLink
} = require('./inboxOpsFormatters');

async function ensureReviewDisplayRef(doc) {
  if (doc.metadata?.reviewDisplayRef) return doc.metadata.reviewDisplayRef;
  const { displayRef } = await generateOpsRef(doc.organization, 'review');
  await Interaction.updateOne(
    { _id: doc._id },
    { $set: { 'metadata.reviewDisplayRef': displayRef } }
  );
  return displayRef;
}

function buildReviewFilter(orgId, query) {
  const filter = { organization: orgId, type: 'review' };
  const { platform, search, from, to, tab, rating } = query;

  if (platform) filter.platform = platform;
  if (from || to) {
    filter.platformCreatedAt = {};
    if (from) filter.platformCreatedAt.$gte = new Date(from);
    if (to) filter.platformCreatedAt.$lte = new Date(to);
  }
  if (search) {
    filter.$or = [
      { 'metadata.reviewDisplayRef': { $regex: search, $options: 'i' } },
      { content: { $regex: search, $options: 'i' } },
      { 'author.name': { $regex: search, $options: 'i' } }
    ];
  }

  if (tab === 'awaiting_reply') {
    filter.status = { $ne: 'replied' };
    filter['metadata.reviewReplyPublished'] = { $ne: true };
  } else if (tab === 'flagged') {
    filter.$or = [
      { sentiment: 'negative' },
      { 'metadata.starRating': { $in: ['ONE', 'TWO', 'THREE', 1, 2, 3] } },
      { 'metadata.rating': { $lte: 3 } }
    ];
  }

  const ratingTab = tab?.startsWith('rating_') ? parseInt(tab.replace('rating_', ''), 10) : null;
  const ratingFilter = ratingTab || (rating ? parseInt(rating, 10) : null);
  if (ratingFilter === 3) {
    filter.$or = [
      { 'metadata.starRating': { $in: ['ONE', 'TWO', 'THREE', 1, 2, 3] } },
      { 'metadata.rating': { $lte: 3 } }
    ];
  } else if (ratingFilter >= 1 && ratingFilter <= 5) {
    const starMap = { 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE' };
    filter.$or = [
      { 'metadata.starRating': starMap[ratingFilter] },
      { 'metadata.rating': ratingFilter }
    ];
  }

  return filter;
}

function replyStatusFor(doc) {
  const hasReply = doc.replies?.some((r) => !r.isPlatformReply && r.status !== 'failed');
  const published = doc.metadata?.reviewReplyPublished || hasReply;
  if (published) return { status: 'published', label: 'PUBLISHED', tone: 'success' };
  if (doc.aiSuggestion?.content) return { status: 'awaiting', label: 'AWAITING APPROVAL', tone: 'warning' };
  return { status: 'none', label: 'NO REPLY', tone: 'neutral' };
}

function mapReviewRow(doc, reviewRequest) {
  const rating = getReviewRating(doc);
  const reply = replyStatusFor(doc);
  const displayRef = doc.metadata?.reviewDisplayRef || doc._id.toString().slice(-8).toUpperCase();
  const customer = customerFromInteraction(doc);

  let requestSentLabel = '—';
  if (reviewRequest?.sentAt) {
    const ch = reviewRequest.channel ? CHANNEL_LABELS[reviewRequest.channel] || reviewRequest.channel : 'WhatsApp';
    requestSentLabel = `Yes · ${ch}`;
  }

  return {
    id: doc._id.toString(),
    interactionId: doc._id.toString(),
    displayRef,
    customerName: customer.name,
    customerHandle: customer.handle,
    platform: doc.platform,
    platformLabel: CHANNEL_LABELS[doc.platform] || doc.platform,
    rating,
    snippet: reviewSnippet(doc.content),
    requestSentLabel,
    collectionStatus: rating ? 'collected' : 'pending',
    collectionStatusLabel: rating ? 'COLLECTED' : 'PENDING',
    replyStatus: reply.status,
    replyStatusLabel: reply.label,
    replyStatusTone: reply.tone,
    createdAt: doc.platformCreatedAt || doc.createdAt,
    createdAtLabel: formatDateLabel(doc.platformCreatedAt || doc.createdAt),
    chatDeepLink: chatDeepLink(doc._id.toString())
  };
}

async function listReviews(orgId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 30));
  const skip = (page - 1) * limit;
  const filter = buildReviewFilter(orgId, query);

  const [docs, total] = await Promise.all([
    Interaction.find(filter)
      .select('platform content author metadata sentiment status replies aiSuggestion platformCreatedAt createdAt organization')
      .sort({ platformCreatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Interaction.countDocuments(filter)
  ]);

  const ids = docs.map((d) => d._id);
  const requests = await ReviewRequest.find({
    organization: orgId,
    interactionId: { $in: ids }
  })
    .select('interactionId sentAt channel')
    .sort({ sentAt: -1 })
    .lean();

  const reqByInteraction = new Map();
  for (const r of requests) {
    const key = r.interactionId?.toString();
    if (key && !reqByInteraction.has(key)) reqByInteraction.set(key, r);
  }

  const rows = [];
  for (const doc of docs) {
    if (!doc.metadata?.reviewDisplayRef) {
      doc.metadata = doc.metadata || {};
      doc.metadata.reviewDisplayRef = await ensureReviewDisplayRef(doc);
    }
    rows.push(mapReviewRow(doc, reqByInteraction.get(doc._id.toString())));
  }

  return { rows, total, page, limit };
}

async function getReviewStats(orgId) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const base = { organization: orgId, type: 'review' };

  const [monthReviews, repliedCount, flaggedCount, ratingAgg] = await Promise.all([
    Interaction.countDocuments({ ...base, platformCreatedAt: { $gte: monthStart } }),
    Interaction.countDocuments({
      ...base,
      $or: [{ status: 'replied' }, { 'metadata.reviewReplyPublished': true }]
    }),
    Interaction.countDocuments({
      ...base,
      status: { $ne: 'replied' },
      'metadata.reviewReplyPublished': { $ne: true },
      $or: [{ sentiment: 'negative' }, { 'metadata.rating': { $lte: 3 } }]
    }),
    Interaction.aggregate([
      { $match: base },
      {
        $project: {
          rating: {
            $ifNull: [
              '$metadata.rating',
              {
                $switch: {
                  branches: [
                    { case: { $eq: ['$metadata.starRating', 'ONE'] }, then: 1 },
                    { case: { $eq: ['$metadata.starRating', 'TWO'] }, then: 2 },
                    { case: { $eq: ['$metadata.starRating', 'THREE'] }, then: 3 },
                    { case: { $eq: ['$metadata.starRating', 'FOUR'] }, then: 4 },
                    { case: { $eq: ['$metadata.starRating', 'FIVE'] }, then: 5 }
                  ],
                  default: null
                }
              }
            ]
          }
        }
      },
      { $match: { rating: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
    ])
  ]);

  return {
    avgRating: ratingAgg[0]?.avg ? +ratingAgg[0].avg.toFixed(1) : 0,
    reviewsThisMonth: monthReviews,
    repliesSent: repliedCount,
    flaggedCount
  };
}

async function getReviewDetail(orgId, interactionId) {
  const doc = await Interaction.findOne({
    _id: interactionId,
    organization: orgId,
    type: 'review'
  }).lean();

  if (!doc) return null;
  if (!doc.metadata?.reviewDisplayRef) {
    doc.metadata = doc.metadata || {};
    doc.metadata.reviewDisplayRef = await ensureReviewDisplayRef(doc);
  }

  const reviewRequest = await ReviewRequest.findOne({
    organization: orgId,
    interactionId: doc._id
  })
    .sort({ sentAt: -1 })
    .lean();

  const row = mapReviewRow(doc, reviewRequest);
  const reply = replyStatusFor(doc);

  return {
    ...row,
    customer: customerFromInteraction(doc),
    reviewBody: doc.content || '',
    aiDraft: doc.aiSuggestion?.content || null,
    aiDraftConfidence: doc.aiSuggestion?.confidence || null,
    platformReviewId: doc.metadata?.reviewId || doc.platformId,
    locationId: doc.metadata?.locationId || null,
    actions: {
      canSuggestReply: !reply.published && doc.platform !== 'website',
      canPublishReply: doc.platform === 'google' || doc.platform === 'facebook',
      canEditReply: true
    },
    chatDeepLink: chatDeepLink(doc._id.toString())
  };
}

async function loadReview(orgId, interactionId) {
  return Interaction.findOne({ _id: interactionId, organization: orgId, type: 'review' });
}

module.exports = {
  listReviews,
  getReviewStats,
  getReviewDetail,
  loadReview,
  ensureReviewDisplayRef,
  buildReviewFilter,
  replyStatusFor,
  mapReviewRow
};
