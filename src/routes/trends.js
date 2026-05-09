const express = require('express');
const router = express.Router();
const axios = require('axios');
const Organization = require('../models/Organization');
const aiCreditService = require('../services/aiCreditService');
const { protect } = require('../middlewares/auth');
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');

/**
 * Trends API
 * GET /api/trends            - list seeded trending topics
 * GET /api/trends/memes      - meme templates
 * GET /api/trends/holidays   - holiday calendar
 * GET /api/trends/industry   - AI-generated industry-specific trends
 *   ?industry=<value>        - optional override; falls back to org.industry
 */
router.use(protect);

// ─── Constants ────────────────────────────────────────────────────────────────
const TREND_CREDIT_COST = 3;
/** In-memory cache: "${orgId}:${normalizedIndustry}" → { data, industry, expiresAt } */
const industryTrendsCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Static seed data ─────────────────────────────────────────────────────────
const TRENDING_SEED = [
  { id: '1', title: 'Sustainable living tips', source: 'Social', relevanceScore: 92, suggestedAngle: 'Share your brand\'s eco-friendly practices or product tips.' },
  { id: '2', title: 'Remote work culture', source: 'LinkedIn', relevanceScore: 88, suggestedAngle: 'Behind-the-scenes of your distributed team or productivity tips.' },
  { id: '3', title: 'Quick recipe ideas', source: 'Instagram', relevanceScore: 85, suggestedAngle: 'Easy recipes or food hacks that fit your audience.' }
];

const MEMES_SEED = [
  { id: 'm1', title: 'Success kid', template: 'success_kid', suggestedAngle: 'Use for celebrating milestones or wins.' },
  { id: 'm2', title: 'This is fine', template: 'this_is_fine', suggestedAngle: 'Relatable take on busy periods or deadlines.' },
  { id: 'm3', title: 'Two buttons', template: 'two_buttons', suggestedAngle: 'Offer two choices or highlight a dilemma.' }
];

const HOLIDAYS_SEED = [
  { date: '2025-12-25', name: 'Christmas', region: 'global' },
  { date: '2025-01-01', name: 'New Year', region: 'global' },
  { date: '2025-02-14', name: 'Valentine\'s Day', region: 'global' },
  { date: '2025-03-08', name: 'International Women\'s Day', region: 'global' },
  { date: '2025-04-22', name: 'Earth Day', region: 'global' }
];

// All trend endpoints require the Trends feature flag — Free plans must not
// see this section in Content Studio. The frontend reads /api/entitlements to
// hide the panel; this gate is the server-side belt-and-braces.
router.use(requireFeature(FEATURE_KEYS.POSTS_TRENDS));

// ─── Static routes ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { q } = req.query;
  let data = TRENDING_SEED;
  if (q && typeof q === 'string') {
    const lower = q.toLowerCase();
    data = data.filter(t =>
      t.title.toLowerCase().includes(lower) ||
      (t.suggestedAngle && t.suggestedAngle.toLowerCase().includes(lower))
    );
  }
  res.json({ success: true, data });
});

router.get('/memes', (req, res) => {
  res.json({ success: true, data: MEMES_SEED });
});

router.get('/holidays', (req, res) => {
  res.json({ success: true, data: HOLIDAYS_SEED });
});

/**
 * GET /api/trends/industry
 * Query params:
 *   industry (optional) — override the org's industry field
 *
 * Credits:
 *   - Cache hit  → 0 credits consumed
 *   - Fresh call → TREND_CREDIT_COST (3) credits deducted
 *
 * Response: { success, industry, data, cached, creditsUsed }
 */
router.get('/industry', async (req, res) => {
  const orgId = req.user.organization?._id?.toString() || req.user.organization?.toString();
  let creditsDeducted = false;

  try {
    // ── Resolve industry ──────────────────────────────────────────────────────
    const requestedIndustry = (req.query.industry || '').trim();
    let industry;

    if (requestedIndustry) {
      industry = requestedIndustry;
    } else {
      const org = await Organization.findById(orgId).select('industry').lean();
      industry = (org && org.industry && org.industry.trim()) || 'general business';
    }

    // ── Cache lookup (keyed by orgId + normalised industry) ───────────────────
    const cacheKey = `${orgId}:${industry.toLowerCase()}`;
    const hit = industryTrendsCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      return res.json({
        success: true,
        industry: hit.industry,
        data: hit.data,
        cached: true,
        creditsUsed: 0
      });
    }

    // ── Credit gate (only for fresh AI calls) ─────────────────────────────────
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ success: false, message: 'AI features are not configured.' });
    }

    const creditCheck = await aiCreditService.checkCredits(orgId, TREND_CREDIT_COST);
    if (!creditCheck.allowed) {
      return res.status(403).json({
        success: false,
        code: 'AI_CREDITS_EXCEEDED',
        message: `Trend generation costs ${TREND_CREDIT_COST} credits. You have ${creditCheck.remaining ?? 0} remaining.`
      });
    }

    // ── OpenAI call ───────────────────────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Today is ${today}. You are a social media trend analyst.

Return exactly 6 trending social media content ideas that are relevant RIGHT NOW for a business in the "${industry}" industry.

Reply ONLY with a valid JSON array — no markdown, no prose, no code fence. Each element must have these exact keys:
- "id": string (1-6)
- "title": short trend headline (max 8 words)
- "platform": one of Instagram | LinkedIn | YouTube | Facebook | TikTok | X
- "relevanceScore": integer 60–99
- "suggestedAngle": one actionable sentence (max 20 words) explaining how to use this trend
- "hashtags": array of exactly 3 hashtag strings starting with #

Make trends feel current and actionable, not generic.`;

    const model = process.env.OPENAI_MODEL || 'gpt-4';
    const isNewModel = /^gpt-5/.test(model.toLowerCase()) || /^o[134]/.test(model.toLowerCase());
    const maxTokensField = isNewModel ? 'max_completion_tokens' : 'max_tokens';

    const payload = {
      model,
      messages: [{ role: 'user', content: prompt }],
      [maxTokensField]: 800
    };
    if (!isNewModel) payload.temperature = 0.8;

    const openaiRes = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });

    const raw = openaiRes.data?.choices?.[0]?.message?.content || '[]';
    let data;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      data = JSON.parse(cleaned);
      if (!Array.isArray(data)) throw new Error('Not an array');
    } catch {
      console.error('[Trends] Failed to parse OpenAI response:', raw.slice(0, 200));
      return res.status(502).json({ success: false, message: 'Could not parse trend data from AI.' });
    }

    // Normalise and cap at 6
    data = data.slice(0, 6).map((item, i) => ({
      id: String(item.id || i + 1),
      title: String(item.title || '').trim(),
      platform: String(item.platform || 'Social').trim(),
      relevanceScore: Math.min(99, Math.max(0, parseInt(item.relevanceScore) || 75)),
      suggestedAngle: String(item.suggestedAngle || '').trim(),
      hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice(0, 3) : []
    }));

    // ── Deduct credits ────────────────────────────────────────────────────────
    await aiCreditService.deductCredits(orgId, TREND_CREDIT_COST, {
      operation: 'trend_generation',
      userId: req.user._id,
      industry
    });
    creditsDeducted = true;

    // ── Store in cache ────────────────────────────────────────────────────────
    industryTrendsCache.set(cacheKey, { data, industry, expiresAt: Date.now() + CACHE_TTL_MS });

    return res.json({
      success: true,
      industry,
      data,
      cached: false,
      creditsUsed: TREND_CREDIT_COST
    });

  } catch (err) {
    console.error('[Trends/industry]', err.message);
    if (creditsDeducted) {
      try {
        await aiCreditService.rollbackCredits(orgId, TREND_CREDIT_COST, { operation: 'trend_generation' });
      } catch (rollbackErr) {
        console.error('[Trends/industry] Credit rollback failed:', rollbackErr.message);
      }
    }
    return res.status(500).json({ success: false, message: 'Failed to load industry trends.' });
  }
});

module.exports = router;
