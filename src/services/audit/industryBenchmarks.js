/**
 * Industry Benchmarks
 *
 * Hardcoded benchmark config for "You vs. Industry" comparisons in the
 * Growth Intelligence Audit report. All values are research-based averages
 * for Indian D2C / SMB markets where available; global averages elsewhere.
 *
 * Structure per industry key:
 *   label             — display name
 *   commentReplyRate  — % of public comments the brand replies to (industry avg)
 *   reviewReplyRate   — % of Google/FB reviews the owner replies to
 *   avgRating         — average Google rating for top-quartile players
 *   buyingIntentReplyRate — % of buying-intent comments that get answered
 *   postingFrequency  — recommended posts/week
 *   avgOrderValue     — default AOV in INR if user doesn't provide one
 *   conversionRate    — estimated % of answered buying-intent → actual purchase
 */

const INDUSTRY_BENCHMARKS = {
  fashion: {
    label: 'Fashion & Apparel',
    commentReplyRate: 72,
    reviewReplyRate: 81,
    avgRating: 4.6,
    buyingIntentReplyRate: 88,
    postingFrequency: 5,
    avgOrderValue: 2200,
    conversionRate: 0.09
  },
  beauty: {
    label: 'Beauty & Personal Care',
    commentReplyRate: 78,
    reviewReplyRate: 85,
    avgRating: 4.7,
    buyingIntentReplyRate: 91,
    postingFrequency: 6,
    avgOrderValue: 1500,
    conversionRate: 0.10
  },
  food_beverage: {
    label: 'Food & Beverage',
    commentReplyRate: 65,
    reviewReplyRate: 79,
    avgRating: 4.4,
    buyingIntentReplyRate: 82,
    postingFrequency: 7,
    avgOrderValue: 800,
    conversionRate: 0.12
  },
  restaurant: {
    label: 'Restaurant & Cafe',
    commentReplyRate: 58,
    reviewReplyRate: 74,
    avgRating: 4.3,
    buyingIntentReplyRate: 77,
    postingFrequency: 5,
    avgOrderValue: 1200,
    conversionRate: 0.11
  },
  healthcare: {
    label: 'Healthcare & Wellness',
    commentReplyRate: 68,
    reviewReplyRate: 88,
    avgRating: 4.6,
    buyingIntentReplyRate: 92,
    postingFrequency: 4,
    avgOrderValue: 2500,
    conversionRate: 0.07
  },
  real_estate: {
    label: 'Real Estate',
    commentReplyRate: 55,
    reviewReplyRate: 70,
    avgRating: 4.2,
    buyingIntentReplyRate: 80,
    postingFrequency: 4,
    avgOrderValue: 500000,
    conversionRate: 0.04
  },
  education: {
    label: 'Education & Coaching',
    commentReplyRate: 74,
    reviewReplyRate: 82,
    avgRating: 4.5,
    buyingIntentReplyRate: 89,
    postingFrequency: 5,
    avgOrderValue: 15000,
    conversionRate: 0.08
  },
  ecommerce: {
    label: 'E-Commerce',
    commentReplyRate: 76,
    reviewReplyRate: 84,
    avgRating: 4.4,
    buyingIntentReplyRate: 90,
    postingFrequency: 6,
    avgOrderValue: 1800,
    conversionRate: 0.09
  },
  fitness: {
    label: 'Fitness & Yoga',
    commentReplyRate: 80,
    reviewReplyRate: 87,
    avgRating: 4.7,
    buyingIntentReplyRate: 92,
    postingFrequency: 7,
    avgOrderValue: 5000,
    conversionRate: 0.10
  },
  travel: {
    label: 'Travel & Hospitality',
    commentReplyRate: 62,
    reviewReplyRate: 78,
    avgRating: 4.3,
    buyingIntentReplyRate: 83,
    postingFrequency: 5,
    avgOrderValue: 25000,
    conversionRate: 0.06
  },
  retail: {
    label: 'Retail & Local Store',
    commentReplyRate: 60,
    reviewReplyRate: 72,
    avgRating: 4.2,
    buyingIntentReplyRate: 79,
    postingFrequency: 4,
    avgOrderValue: 1500,
    conversionRate: 0.10
  },
  general: {
    label: 'General Business',
    commentReplyRate: 70,
    reviewReplyRate: 80,
    avgRating: 4.4,
    buyingIntentReplyRate: 85,
    postingFrequency: 5,
    avgOrderValue: 2000,
    conversionRate: 0.08
  }
};

/**
 * Get benchmarks for an industry key.
 * Falls back to 'general' if the key is not found.
 *
 * @param {string} industryKey
 * @returns {object}
 */
function getBenchmarks(industryKey) {
  return INDUSTRY_BENCHMARKS[industryKey] || INDUSTRY_BENCHMARKS.general;
}

/**
 * Return the list of industries for frontend dropdowns.
 * @returns {Array<{value: string, label: string}>}
 */
function listIndustries() {
  return Object.entries(INDUSTRY_BENCHMARKS).map(([value, data]) => ({
    value,
    label: data.label
  }));
}

module.exports = { getBenchmarks, listIndustries, INDUSTRY_BENCHMARKS };
