/**
 * Audit Scoring Service
 *
 * Responsibility: compute all 5 Growth Intelligence modules from raw provider
 * data, generate a 0–100 Conversation Score, A–F grade, and call OpenAI to
 * write the AI Recommendations paragraph.
 *
 * ALL computation happens here — the frontend only renders what this service
 * returns.
 */

const openaiClient = require('../ai/openaiClient');
const { getBenchmarks } = require('./industryBenchmarks');
const { openAIChatCompletionTemperatureField, openAIChatCompletionMaxTokensField } = require('../../utils/openaiModelHelpers');
const logger = require('../../config/logger');

// ── Score weights ──────────────────────────────────────────────────────────────
// The Conversation Score is a weighted composite (0–100).
const WEIGHTS = {
  igReplyRate: 0.25,       // Instagram comment reply rate (most visible)
  fbReplyRate: 0.10,       // Facebook comment reply rate
  googleReplyRate: 0.20,   // Google review response rate (trust signal)
  googleRating: 0.15,      // Google rating (reputation baseline)
  buyingIntentHandled: 0.20,// % of buying-intent comments answered
  postingConsistency: 0.10 // posting frequency / gap penalty
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function gradeFromScore(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val || 0));
}

/**
 * Normalise a raw rate (0–100 %) to a 0–1 weight contribution.
 * A rate at benchmark gets 0.75; above benchmark gets up to 1; below scales down.
 */
function normRate(rate, benchmark) {
  const ratio = rate / (benchmark || 1);
  return clamp(ratio * 0.75, 0, 1);
}

/** Normalise a Google rating (1–5) to 0–1. */
function normRating(rating, benchmarkRating) {
  if (!rating) return 0;
  return clamp((rating - 1) / 4, 0, 1) * (rating / (benchmarkRating || 4.4));
}

// ── M1 — Social Presence ─────────────────────────────────────────────────────

function computeSocialPresence(igRaw, fbRaw) {
  return {
    igFollowers:         igRaw.followers || 0,
    igPosts:             igRaw.posts || 0,
    igComments:          igRaw.comments || 0,
    igReplies:           igRaw.replies || 0,
    igReplyRate:         Math.round(igRaw.replyRate || 0),
    igBuyingIntentCount: igRaw.buyingIntentCount || 0,
    igUnansweredBuying:  igRaw.unansweredBuying || 0,
    igPostingGaps:       !!igRaw.postingGaps,
    igAvgEngagement:     igRaw.avgEngagement || 0,
    fbPosts:             fbRaw.posts || 0,
    fbComments:          fbRaw.comments || 0,
    fbReplies:           fbRaw.replies || 0,
    fbReplyRate:         Math.round(fbRaw.replyRate || 0)
  };
}

// ── M2 — Reputation ──────────────────────────────────────────────────────────

function computeReputation(googleRaw, fbRaw) {
  return {
    google: {
      rating:            googleRaw.rating || 0,
      totalReviews:      googleRaw.totalReviews || 0,
      ownerReplyRate:    Math.round(googleRaw.ownerReplyRate || 0),
      unansweredNegative:googleRaw.unansweredNegative || 0
    },
    facebook: {
      rating:            fbRaw.rating || 0,
      commentReplyRate:  Math.round(fbRaw.replyRate || 0)
    }
  };
}

// ── M4 — Revenue Leak ─────────────────────────────────────────────────────────

function computeRevenueLeak(socialPresence, avgOrderValue, conversionRate) {
  const unanswered = (socialPresence.igUnansweredBuying || 0);
  const leakNumber = Math.round(unanswered * conversionRate * avgOrderValue);
  return {
    number:               leakNumber,
    unansweredBuying:     unanswered,
    estimatedConversion:  conversionRate,
    avgOrderValue,
    formula: `${unanswered} unanswered buying comments × ${Math.round(conversionRate * 100)}% estimated conversion × ₹${avgOrderValue.toLocaleString('en-IN')} avg order value = ₹${leakNumber.toLocaleString('en-IN')}/month`
  };
}

// ── M9 — Opportunity Calculator ───────────────────────────────────────────────

function computeOpportunityCalc(socialPresence, reputation, benchmarks, avgOrderValue, conversionRate) {
  const items = [];

  // Opportunity 1: Improve Instagram comment reply rate
  const currentIgReply = socialPresence.igReplyRate || 0;
  const benchIgReply = benchmarks.commentReplyRate || 75;
  if (currentIgReply < benchIgReply) {
    const upliftFraction = ((benchIgReply - currentIgReply) / 100) * 0.38;
    items.push({
      metric: 'Comment Reply Rate',
      currentValue: currentIgReply,
      improvedValue: benchIgReply,
      unit: '%',
      upliftLabel: `+${Math.round(upliftFraction * 100)}% Lead Conversions`,
      upliftFraction: +upliftFraction.toFixed(2)
    });
  }

  // Opportunity 2: Improve Google review response rate
  const currentGoogleReply = reputation.google?.ownerReplyRate || 0;
  const benchGoogleReply = benchmarks.reviewReplyRate || 80;
  if (currentGoogleReply < benchGoogleReply) {
    const ratingUplift = Math.round((benchGoogleReply - currentGoogleReply) / 100 * 0.3 * 10) / 10;
    items.push({
      metric: 'Google Review Response Rate',
      currentValue: currentGoogleReply,
      improvedValue: benchGoogleReply,
      unit: '%',
      upliftLabel: `+${ratingUplift} Star Rating (estimated)`,
      upliftFraction: ratingUplift / 5
    });
  }

  // Opportunity 3: Buying intent response → revenue
  const unanswered = socialPresence.igUnansweredBuying || 0;
  if (unanswered > 5) {
    const revenueGain = Math.round(unanswered * conversionRate * avgOrderValue);
    items.push({
      metric: 'Buying Intent Comments Answered',
      currentValue: Math.round((socialPresence.igBuyingIntentCount - unanswered) / Math.max(socialPresence.igBuyingIntentCount, 1) * 100),
      improvedValue: benchmarks.buyingIntentReplyRate || 88,
      unit: '%',
      upliftLabel: `+₹${revenueGain.toLocaleString('en-IN')}/month Revenue`,
      upliftFraction: +((benchmarks.buyingIntentReplyRate - 20) / 100).toFixed(2)
    });
  }

  return items;
}

// ── Conversation Score ─────────────────────────────────────────────────────────

function computeConversationScore(socialPresence, reputation, benchmarks) {
  const igReplyContrib     = normRate(socialPresence.igReplyRate, benchmarks.commentReplyRate) * WEIGHTS.igReplyRate;
  const fbReplyContrib     = normRate(socialPresence.fbReplyRate, benchmarks.commentReplyRate) * WEIGHTS.fbReplyRate;
  const googleReplyContrib = normRate(reputation.google?.ownerReplyRate, benchmarks.reviewReplyRate) * WEIGHTS.googleReplyRate;
  const googleRatingContrib= normRating(reputation.google?.rating, benchmarks.avgRating) * WEIGHTS.googleRating;

  const totalBuying = socialPresence.igBuyingIntentCount || 1;
  const answeredBuying = totalBuying - (socialPresence.igUnansweredBuying || 0);
  const buyingRate = (answeredBuying / totalBuying) * 100;
  const buyingContrib = normRate(buyingRate, benchmarks.buyingIntentReplyRate) * WEIGHTS.buyingIntentHandled;

  const postingContrib = socialPresence.igPostingGaps ? 0 : WEIGHTS.postingConsistency;

  const raw = (igReplyContrib + fbReplyContrib + googleReplyContrib + googleRatingContrib + buyingContrib + postingContrib) * 100;
  return Math.round(clamp(raw, 0, 100));
}

// ── M8 — AI Recommendations ──────────────────────────────────────────────────

async function generateAIRecommendations({ businessName, industry, socialPresence, reputation, revenueLeak, score, grade, benchmarks }) {
  if (!openaiClient.hasApiKey()) {
    return defaultRecommendations(socialPresence, reputation, revenueLeak, benchmarks);
  }

  const systemPrompt = `You are RepMeUp AI, a Growth Intelligence consultant for Indian businesses. You write brutally honest, data-driven growth recommendations for D2C and SMB brands.

Your recommendations must:
- Reference the EXACT numbers provided
- Be specific and actionable
- Mention how RepMeUp can fix each problem
- Use Indian market context (₹, Indian audience behaviour)
- Be concise and punchy (not corporate fluff)

Return ONLY a valid JSON array (no markdown, no explanations):
[
  { "rank": 1, "title": "...", "explanation": "...", "expectedImpact": "...", "feature": "..." },
  { "rank": 2, "title": "...", "explanation": "...", "expectedImpact": "...", "feature": "..." },
  { "rank": 3, "title": "...", "explanation": "...", "expectedImpact": "...", "feature": "..." }
]`;

  const userPrompt = `Analyse this business and write 3 ranked growth recommendations:

Business: ${businessName || 'this business'}
Industry: ${industry}
Conversation Score: ${score}/100 (Grade: ${grade})

Instagram:
- Reply rate: ${socialPresence.igReplyRate}% (industry benchmark: ${benchmarks.commentReplyRate}%)
- Buying-intent comments: ${socialPresence.igBuyingIntentCount} total, ${socialPresence.igUnansweredBuying} UNANSWERED
- Posting gaps: ${socialPresence.igPostingGaps ? 'Yes — missing days in last 30 days' : 'No'}

Google Reviews:
- Rating: ${reputation.google?.rating}/5 (${reputation.google?.totalReviews} reviews)
- Owner reply rate: ${reputation.google?.ownerReplyRate}% (benchmark: ${benchmarks.reviewReplyRate}%)
- Unanswered negative reviews: ${reputation.google?.unansweredNegative}

Revenue Leak: ₹${revenueLeak.number?.toLocaleString('en-IN')}/month from ${revenueLeak.unansweredBuying} unanswered buying comments

Each recommendation must cite specific numbers from this data, state what RepMeUp feature fixes it (e.g. Comment Commerce, AI Auto-Reply, Review Responder), and give a realistic expectedImpact in terms of leads/revenue/conversions.`;

  try {
    const resp = await openaiClient.chatCompletion({
      model: openaiClient.classificationModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      [openAIChatCompletionTemperatureField(openaiClient.classificationModel)]: 0.5,
      [openAIChatCompletionMaxTokensField(openaiClient.classificationModel)]: 600
    }, { feature: 'growth_audit.ai_recommendations' });

    const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return defaultRecommendations(socialPresence, reputation, revenueLeak, benchmarks);
  } catch (err) {
    logger.warn('[auditScoringService] AI recommendations failed — using defaults', { error: err.message });
    return defaultRecommendations(socialPresence, reputation, revenueLeak, benchmarks);
  }
}

function defaultRecommendations(socialPresence, reputation, revenueLeak, benchmarks) {
  const recs = [];
  let rank = 1;

  if ((socialPresence.igUnansweredBuying || 0) > 5) {
    recs.push({
      rank: rank++,
      title: 'Stop Ignoring Buying-Intent Comments',
      explanation: `${socialPresence.igUnansweredBuying} people asked about pricing, availability, or orders on your Instagram and got no reply. These are your hottest leads — and they went to a competitor.`,
      expectedImpact: `+${Math.round((socialPresence.igUnansweredBuying || 0) * 0.08)} potential orders/month`,
      feature: 'Comment Commerce'
    });
  }

  if ((reputation.google?.ownerReplyRate || 0) < (benchmarks.reviewReplyRate || 80)) {
    recs.push({
      rank: rank++,
      title: 'Reply to Every Google Review',
      explanation: `You reply to only ${reputation.google?.ownerReplyRate}% of Google reviews. The industry average is ${benchmarks.reviewReplyRate}%. ${reputation.google?.unansweredNegative} negative reviews are sitting unanswered — pushing potential customers away.`,
      expectedImpact: '+0.3 to +0.5 star rating over 60 days',
      feature: 'Review Responder'
    });
  }

  recs.push({
    rank: rank++,
    title: 'Automate Common Questions with AI',
    explanation: `Customers repeatedly ask the same questions: price, availability, delivery, timing. RepMeUp AI can answer these instantly — 24/7 — without your team lifting a finger.`,
    expectedImpact: '-80% manual response time, +35% lead capture rate',
    feature: 'AI Auto-Reply'
  });

  return recs.slice(0, 3);
}

// ── Main scoring entry point ──────────────────────────────────────────────────

/**
 * Score raw provider data and return the complete audit module object.
 *
 * @param {{ ig, fb, google }} rawData   - Provider results (may be partial/mock)
 * @param {string} industry             - Industry key from INDUSTRY_BENCHMARKS
 * @param {number} inputAvgOrderValue   - User-provided AOV in INR (0 = use default)
 * @param {string} businessName
 * @returns {Promise<{ modules, benchmarks, score, grade }>}
 */
async function score(rawData, industry, inputAvgOrderValue, businessName) {
  const benchmarks = getBenchmarks(industry);
  const avgOrderValue = inputAvgOrderValue > 0 ? inputAvgOrderValue : benchmarks.avgOrderValue;
  const conversionRate = benchmarks.conversionRate;

  const ig = rawData.ig || {};
  const fb = rawData.fb || {};
  const google = rawData.google || {};

  const socialPresence = computeSocialPresence(ig, fb);
  const reputation     = computeReputation(google, fb);
  const revenueLeak    = computeRevenueLeak(socialPresence, avgOrderValue, conversionRate);
  const opportunityCalc= computeOpportunityCalc(socialPresence, reputation, benchmarks, avgOrderValue, conversionRate);
  const conversationScore = computeConversationScore(socialPresence, reputation, benchmarks);
  const grade = gradeFromScore(conversationScore);

  const aiRecommendations = await generateAIRecommendations({
    businessName,
    industry: benchmarks.label,
    socialPresence,
    reputation,
    revenueLeak,
    score: conversationScore,
    grade,
    benchmarks
  });

  return {
    modules: {
      socialPresence,
      reputation,
      revenueLeak,
      aiRecommendations,
      opportunityCalc
    },
    benchmarks,
    score: conversationScore,
    grade
  };
}

module.exports = { score };
