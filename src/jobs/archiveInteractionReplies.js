/**
 * Archive excess Interaction.replies to keep documents bounded during large campaigns.
 */
const Interaction = require('../models/Interaction');
const campaignConfig = require('../config/campaignConfig');
const logger = require('../config/logger');

async function archiveExcessReplies() {
  const maxInline = campaignConfig.maxInlineReplies;
  const batchSize = campaignConfig.archiveBatchSize;

  const candidates = await Interaction.find({
    'replies.0': { $exists: true },
    $expr: { $gt: [{ $size: '$replies' }, maxInline] }
  })
    .select('_id organization replies')
    .limit(batchSize)
    .lean();

  if (!candidates.length) return { archived: 0 };

  let archived = 0;
  for (const doc of candidates) {
    const replies = doc.replies || [];
    if (replies.length <= maxInline) continue;

    const keep = maxInline;
    const toArchive = replies.slice(0, replies.length - keep);
    const kept = replies.slice(-keep);

    await Interaction.updateOne(
      { _id: doc._id },
      {
        $set: {
          replies: kept,
          'metadata.archivedReplyCount': (doc.metadata?.archivedReplyCount || 0) + toArchive.length,
          'metadata.lastReplyArchiveAt': new Date()
        }
      }
    );
    archived += toArchive.length;
  }

  logger.info('[InteractionArchive] Trimmed excess replies', {
    threads: candidates.length,
    repliesArchived: archived
  });

  return { threads: candidates.length, repliesArchived: archived };
}

module.exports = archiveExcessReplies;
