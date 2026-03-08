const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');

/**
 * Trends API - Phase 1: static/seed data for Trend Explorer.
 * GET /api/trends - list trending topics
 * GET /api/trends/memes - meme templates
 * GET /api/trends/holidays - holiday calendar
 */
router.use(protect);

// Static seed data for Phase 1
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

router.get('/', (req, res) => {
  const { q } = req.query;
  let data = TRENDING_SEED;
  if (q && typeof q === 'string') {
    const lower = q.toLowerCase();
    data = data.filter(t => t.title.toLowerCase().includes(lower) || (t.suggestedAngle && t.suggestedAngle.toLowerCase().includes(lower)));
  }
  res.json({ success: true, data });
});

router.get('/memes', (req, res) => {
  res.json({ success: true, data: MEMES_SEED });
});

router.get('/holidays', (req, res) => {
  res.json({ success: true, data: HOLIDAYS_SEED });
});

module.exports = router;
