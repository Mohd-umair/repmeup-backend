const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const {
  webhookQueue,
  aiQueue,
  autoReplyQueue,
  scheduledPublishQueue,
  brandAnalysisQueue,
  syncQueue,
  notificationQueue,
  voiceCallQueue
} = require('./queue');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Order: active queues first (most useful), dormant queues last.
// Dormant queues are kept visible so operators notice if jobs ever appear there.
createBullBoard({
  queues: [
    new BullAdapter(webhookQueue),
    new BullAdapter(aiQueue),
    new BullAdapter(autoReplyQueue),
    new BullAdapter(scheduledPublishQueue),
    new BullAdapter(brandAnalysisQueue),
    new BullAdapter(voiceCallQueue),
    new BullAdapter(syncQueue),         // dormant — see docs/queues.md
    new BullAdapter(notificationQueue)  // dormant — see docs/queues.md
  ],
  serverAdapter
});

module.exports = serverAdapter;
