const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');
const AICreditUsage = require('../models/AICreditUsage');
const AiApiUsage = require('../models/AiApiUsage');
const entitlementsService = require('./entitlementsService');
const { ensureAiCreditPeriodCurrent } = require('./creditPeriodService');
const { getAiRequestContext, clearLastAiApiUsageId } = require('./aiRequestContext');

/**
 * AI Credit Service - Single Responsibility Principle
 * Manages AI credit limits and usage tracking
 */
class AICreditService {
  /**
   * Check if organization has enough AI credits for an operation.
   * Triggers a lazy UTC-month rollover (carry-forward) before checking.
   * @param {String} organizationId
   * @param {Number} estimatedCost - Estimated credits needed
   * @returns {Promise<Object>} { allowed: Boolean, current?, limit?, remaining?, needed? }
   */
  async checkCredits(organizationId, estimatedCost = 1) {
    try {
      const period = await ensureAiCreditPeriodCurrent(organizationId);

      if (period.isUnlimited) {
        return {
          allowed: true,
          current: period.used,
          limit: -1,
          remaining: Infinity,
          isUnlimited: true
        };
      }

      const { effectiveLimit, carriedCredits, planLimit } = period;
      const currentUsage = period.used;
      const remaining = Math.max(0, effectiveLimit - currentUsage);
      const allowed = currentUsage + estimatedCost <= effectiveLimit;

      if (!allowed) {
        return {
          allowed: false,
          current: currentUsage,
          limit: effectiveLimit,
          planLimit,
          carriedCredits,
          remaining,
          needed: estimatedCost,
          exceededBy: (currentUsage + estimatedCost) - effectiveLimit,
          code: 'AI_CREDITS_EXCEEDED',
          error: `Insufficient AI credits. You need ${estimatedCost} credits but have ${remaining} remaining this month.`
        };
      }

      return {
        allowed: true,
        current: currentUsage,
        limit: effectiveLimit,
        planLimit,
        carriedCredits,
        remaining,
        needed: estimatedCost
      };
    } catch (error) {
      console.error('Check AI credits error:', error);
      throw error;
    }
  }

  /**
   * Deduct AI credits after successful operation.
   * Triggers a lazy rollover before incrementing so the period is always current.
   * @param {object} [linkOptions] Optional `aiApiUsageId` to attach product credits to `AiApiUsage` when deduct runs outside ALS.
   */
  async deductCredits(organizationId, actualCost = 1, metadata = {}, linkOptions = {}) {
    try {
      // Ensure the period is current (lazy rollover) before incrementing usage,
      // so we never count debits against a stale period.
      await ensureAiCreditPeriodCurrent(organizationId);

      const result = await Subscription.findOneAndUpdate(
        { organization: organizationId },
        { 
          $inc: { 'usage.aiCreditsThisMonth': actualCost },
          $set: { 'usage.lastAIUsage': new Date() }
        },
        { new: true }
      );

      if (!result) {
        console.warn(`⚠️ [AI Credits] No subscription found for org ${organizationId} when deducting credits`);
        return { success: false };
      }

      const explicitId =
        linkOptions.aiApiUsageId && mongoose.Types.ObjectId.isValid(String(linkOptions.aiApiUsageId))
          ? String(linkOptions.aiApiUsageId)
          : null;
      const store = getAiRequestContext();
      const fromContext =
        !explicitId &&
        store &&
        store.lastAiApiUsageId &&
        mongoose.Types.ObjectId.isValid(String(store.lastAiApiUsageId))
          ? String(store.lastAiApiUsageId)
          : null;
      const linkedUsageId = explicitId || fromContext;

      const creditMeta = {
        ...metadata,
        userId: undefined,
        operation: undefined,
        ...(linkedUsageId ? { aiApiUsageId: linkedUsageId } : {})
      };

      // Log usage event for history tracking
      try {
        await AICreditUsage.create({
          organization: organizationId,
          user: metadata.userId || organizationId, // Fallback to org ID if user not provided
          operation: metadata.operation || 'unknown',
          creditsUsed: actualCost,
          metadata: creditMeta
        });
      } catch (logError) {
        console.error('Error logging AI credit usage:', logError);
        // Don't fail the deduction if logging fails
      }

      if (linkedUsageId) {
        try {
          await AiApiUsage.findByIdAndUpdate(linkedUsageId, {
            $set: {
              applicationCreditsUsed: actualCost,
              creditOperation: metadata.operation || 'unknown'
            }
          });
        } catch (linkErr) {
          console.error('Error linking application credits to AiApiUsage:', linkErr.message);
        }
        clearLastAiApiUsageId();
      }

      console.log(`💰 [AI Credits] Deducted ${actualCost} credits for org ${organizationId}. New total: ${result.usage.aiCreditsThisMonth}/${result.limits.maxAICreditsPerMonth}`);

      return {
        success: true,
        current: result.usage.aiCreditsThisMonth,
        limit: result.limits.maxAICreditsPerMonth,
        remaining: result.limits.maxAICreditsPerMonth === -1 
          ? Infinity 
          : Math.max(0, result.limits.maxAICreditsPerMonth - result.usage.aiCreditsThisMonth),
        deducted: actualCost,
        metadata
      };
    } catch (error) {
      console.error('Deduct AI credits error:', error);
      throw error;
    }
  }

  /**
   * Rollback (refund) previously deducted credits when an operation fails after deduction.
   * @param {String} organizationId
   * @param {Number} amount - Credits to refund
   * @param {Object} metadata - Context about why the rollback happened
   * @returns {Promise<Object>} Updated usage
   */
  async rollbackCredits(organizationId, amount = 1, metadata = {}) {
    if (!amount || amount <= 0) return { success: true, refunded: 0 };
    try {
      const result = await Subscription.findOneAndUpdate(
        { organization: organizationId },
        { $inc: { 'usage.aiCreditsThisMonth': -amount } },
        { new: true }
      );

      if (!result) {
        console.warn(`⚠️ [AI Credits Rollback] No subscription found for org ${organizationId}`);
        return { success: false };
      }

      try {
        await AICreditUsage.create({
          organization: organizationId,
          user: metadata.userId || organizationId,
          operation: metadata.operation ? `rollback_${metadata.operation}` : 'rollback',
          creditsUsed: -amount,
          metadata: {
            ...metadata,
            userId: undefined,
            operation: undefined,
            reason: metadata.reason || 'Operation failed after deduction'
          }
        });
      } catch (logError) {
        console.error('Error logging AI credit rollback:', logError);
      }

      console.log(`↩️ [AI Credits] Rolled back ${amount} credits for org ${organizationId}. New total: ${result.usage.aiCreditsThisMonth}/${result.limits.maxAICreditsPerMonth}`);

      return { success: true, refunded: amount };
    } catch (error) {
      console.error('Rollback AI credits error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get AI credit usage history for organization
   * @param {String} organizationId
   * @param {Object} options - Query options (page, limit, startDate, endDate)
   * @returns {Promise<Object>} Usage history with pagination
   */
  async getUsageHistory(organizationId, options = {}) {
    try {
      const page = parseInt(options.page) || 1;
      const limit = parseInt(options.limit) || 20;
      const skip = (page - 1) * limit;

      const query = { organization: organizationId };

      // Date filtering
      if (options.startDate || options.endDate) {
        query.createdAt = {};
        if (options.startDate) query.createdAt.$gte = new Date(options.startDate);
        if (options.endDate) query.createdAt.$lte = new Date(options.endDate);
      }

      const [usageHistory, total] = await Promise.all([
        AICreditUsage.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('-__v')
          .populate('user', 'firstName lastName email')
          .lean(),
        AICreditUsage.countDocuments(query)
      ]);

      return {
        data: usageHistory,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Get AI credit usage history error:', error);
      throw error;
    }
  }

  /**
   * Paginated AI credit events for a single user within an organization (super-admin / audit).
   * @param {String} organizationId
   * @param {String} userId
   * @param {Object} options - page, limit (max 200), startDate, endDate
   */
  async getUsageHistoryForUser(organizationId, userId, options = {}) {
    try {
      const page = Math.max(1, parseInt(options.page, 10) || 1);
      let limit = parseInt(options.limit, 10) || 25;
      limit = Math.min(Math.max(1, limit), 200);
      const skip = (page - 1) * limit;

      const query = { organization: organizationId, user: userId };

      if (options.startDate || options.endDate) {
        query.createdAt = {};
        if (options.startDate) query.createdAt.$gte = new Date(options.startDate);
        if (options.endDate) query.createdAt.$lte = new Date(options.endDate);
      }

      const [items, total, sumAgg] = await Promise.all([
        AICreditUsage.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('operation creditsUsed metadata createdAt')
          .lean(),
        AICreditUsage.countDocuments(query),
        AICreditUsage.aggregate([
          {
            $match: {
              organization: new mongoose.Types.ObjectId(String(organizationId)),
              user: new mongoose.Types.ObjectId(String(userId))
            }
          },
          { $group: { _id: null, totalCredits: { $sum: '$creditsUsed' } } }
        ])
      ]);

      const lifetimeCreditsUsed = sumAgg[0]?.totalCredits ?? 0;

      return {
        items,
        lifetimeCreditsUsed,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 0
        }
      };
    } catch (error) {
      console.error('Get AI credit usage history for user error:', error);
      throw error;
    }
  }

  /**
   * Calculate actual credits used based on tokens or words
   * @param {Number} inputTokens
   * @param {Number} outputTokens
   * @param {Number} baseCredits - Base credits for the operation (default 1)
   * @returns {Number} Actual credits to deduct
   */
  calculateCreditsFromTokens(inputTokens = 0, outputTokens = 0, baseCredits = 1) {
    const totalTokens = inputTokens + outputTokens;
    // 1 credit per 500 tokens, min baseCredits, max 10 per operation
    const fromTokens = Math.ceil(totalTokens / 500);
    return Math.max(baseCredits, Math.min(10, fromTokens));
  }

  /**
   * Calculate credits from word count and tag count (for knowledge base)
   * @param {Number} wordCount
   * @param {Number} tagCount
   * @returns {Number} Estimated credits
   */
  calculateCreditsFromWordCount(wordCount = 0, tagCount = 0) {
    const fromWords = Math.ceil(wordCount / 500);
    const fromTags = Math.ceil(tagCount / 5);
    const total = Math.max(1, fromWords + fromTags);
    return Math.min(10, total);
  }

  /**
   * Get AI credit usage for organization.
   * Triggers a lazy rollover and resolves the limit from entitlements (not the
   * stale snapshot on the Subscription document) to keep the header chip and
   * billing page consistent with checkCredits enforcement.
   * @param {String} organizationId
   * @returns {Promise<Object>} Usage stats including carry-forward breakdown
   */
  async getUsage(organizationId) {
    try {
      const period = await ensureAiCreditPeriodCurrent(organizationId);

      if (period.isUnlimited) {
        return {
          current: period.used,
          limit: -1,
          carriedCredits: 0,
          effectiveLimit: -1,
          remaining: Infinity,
          percentage: 0,
          isUnlimited: true,
          isNearLimit: false,
          isAtLimit: false
        };
      }

      const { planLimit, carriedCredits, used, effectiveLimit, remaining } = period;
      const percentage = effectiveLimit > 0 ? (used / effectiveLimit) * 100 : 0;

      return {
        current: used,
        limit: effectiveLimit,
        planLimit,
        carriedCredits,
        effectiveLimit,
        remaining,
        percentage: Math.round(percentage),
        isUnlimited: false,
        isNearLimit: percentage >= 90,
        isAtLimit: used >= effectiveLimit
      };
    } catch (error) {
      console.error('Get AI credit usage error:', error);
      throw error;
    }
  }
}

module.exports = new AICreditService();
