/**
 * Scheduled Publish Job
 * Runs periodically (e.g. every 1 min) to publish ScheduledPosts whose scheduledFor is in the past.
 */
const ScheduledPost = require('../models/ScheduledPost');
const postController = require('../controllers/postController');

module.exports = async function processScheduledPublish() {
  const now = new Date();
  const due = await ScheduledPost.find({
    status: 'scheduled',
    scheduledFor: { $lte: now }
  })
    .select('_id')
    .lean();

  if (due.length === 0) {
    return { published: 0 };
  }

  let published = 0;
  let failed = 0;
  for (const { _id } of due) {
    try {
      const result = await postController.executePublishForScheduledPost(_id.toString());
      if (result.success) published++;
      else failed++;
    } catch (err) {
      console.error('[processScheduledPublish] Error publishing post', _id, err.message);
      failed++;
    }
  }

  if (published > 0 || failed > 0) {
    console.log(`[processScheduledPublish] Due posts: ${due.length}, published: ${published}, failed: ${failed}`);
  }
  return { published, failed };
};
