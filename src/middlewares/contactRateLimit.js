'use strict';

const rateLimit = require('express-rate-limit');

const skipDev = () => process.env.NODE_ENV === 'development' || process.env.RATE_LIMIT_DISABLED === 'true';

function orgUserKey(req) {
  const org = req.user?.organization?._id || req.user?.organization || 'unknown';
  const user = req.user?._id || req.ip;
  return `${org}:${user}`;
}

/** CSV import — expensive, limit per org/user */
const contactImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: orgUserKey,
  message: { success: false, error: 'Import limit reached. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipDev
});

/** AI campaign copy — OpenAI cost guard */
const campaignAiGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: orgUserKey,
  message: { success: false, error: 'AI generation limit reached. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipDev
});

/** Duplicate scan — full-org pass */
const duplicateScanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  keyGenerator: orgUserKey,
  message: { success: false, error: 'Duplicate scan limit reached. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipDev
});

module.exports = {
  contactImportLimiter,
  campaignAiGenerateLimiter,
  duplicateScanLimiter
};
