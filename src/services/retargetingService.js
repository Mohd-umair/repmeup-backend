/**
 * Retargeting Service
 * Audience evaluation + flow tick scheduler
 */
const RetargetingFlow = require('../models/RetargetingFlow');
const RetargetingMembership = require('../models/RetargetingMembership');
const logger = require('../config/logger');

/**
 * Estimate how many contacts match an audience filter.
 */
exports.estimateAudienceSize = async (orgId, audienceType, filters = {}) => {
  try {
    const Contact = require('../models/Contact');
    const Interaction = require('../models/Interaction');

    switch (audienceType) {
      case 'ig_engagers': {
        const days = filters.days || 30;
        const since = new Date(Date.now() - days * 86400000);
        const distinct = await Interaction.distinct('contact', {
          organization: orgId,
          platform: 'instagram',
          createdAt: { $gte: since },
          contact: { $ne: null }
        });
        return distinct.length;
      }
      case 'abandoned_cart': {
        // Count CommerceOrders that are stuck at cart_started or payment_pending (>1h ago)
        // AND the legacy ProductOrder dm_sent records.
        const CommerceOrder = require('../models/CommerceOrder');
        const ProductOrder = require('../models/ProductOrder');
        const oneHourAgo = new Date(Date.now() - 3600000);
        const [commerceAbandoned, igAbandoned] = await Promise.all([
          CommerceOrder.countDocuments({
            organization: orgId,
            status: { $in: ['cart_started', 'payment_pending'] },
            updatedAt: { $lt: oneHourAgo }
          }),
          ProductOrder.countDocuments({
            organization: orgId,
            status: 'dm_sent',
            createdAt: { $lt: oneHourAgo }
          })
        ]);
        return commerceAbandoned + igAbandoned;
      }
      case 'new_leads': {
        const days = filters.days || 7;
        const since = new Date(Date.now() - days * 86400000);
        return await Interaction.distinct('contact', {
          organization: orgId,
          status: 'new',
          createdAt: { $gte: since },
          contact: { $ne: null }
        }).then(a => a.length);
      }
      case 'customer_segment': {
        const q = { organization: orgId };
        if (filters.tag) q.tags = filters.tag;
        return await Contact.countDocuments(q);
      }
      case 'all_contacts':
      default:
        return await Contact.countDocuments({ organization: orgId });
    }
  } catch (err) {
    logger.error('[retargetingService] estimateAudienceSize error', { error: err.message });
    return 0;
  }
};

/**
 * Tick all active flows — enqueue the next step for members whose nextActionAt <= now.
 * Called by a BullMQ scheduled job.
 */
exports.tickFlows = async () => {
  try {
    const now = new Date();
    const dueMembers = await RetargetingMembership.find({
      status: 'active',
      nextActionAt: { $lte: now }
    })
      .populate('flow')
      .limit(500)
      .lean();

    let processed = 0;
    for (const member of dueMembers) {
      try {
        await _processStep(member);
        processed++;
      } catch (err) {
        logger.warn('[retargetingService] tickFlows step error', { memberId: member._id, error: err.message });
      }
    }
    logger.info(`[retargetingService] tickFlows processed ${processed}/${dueMembers.length} members`);
  } catch (err) {
    logger.error('[retargetingService] tickFlows error', { error: err.message });
  }
};

async function _processStep(member) {
  const flow = member.flow;
  if (!flow || !flow.steps?.length) {
    await RetargetingMembership.findByIdAndUpdate(member._id, { status: 'completed', completedAt: new Date() });
    return;
  }

  const step = flow.steps.find(s => s.order === member.currentStep);
  if (!step) {
    await RetargetingMembership.findByIdAndUpdate(member._id, { status: 'completed', completedAt: new Date() });
    return;
  }

  // Future: dispatch message via whatsappService / emailService / smsService
  // For now: just advance the step
  const nextStep = flow.steps.find(s => s.order === member.currentStep + 1);
  if (nextStep) {
    const nextActionAt = new Date(Date.now() + (nextStep.delaySec || 0) * 1000);
    await RetargetingMembership.findByIdAndUpdate(member._id, {
      currentStep: nextStep.order,
      nextActionAt,
      lastMessageAt: new Date()
    });
  } else {
    await RetargetingMembership.findByIdAndUpdate(member._id, {
      status: 'completed',
      completedAt: new Date()
    });
    await RetargetingFlow.findByIdAndUpdate(flow._id, { $inc: { 'stats.completed': 1 } });
  }
}
