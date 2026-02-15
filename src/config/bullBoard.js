const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const { 
  webhookQueue, 
  aiQueue, 
  autoReplyQueue, 
  syncQueue, 
  notificationQueue 
} = require('./queue');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullAdapter(webhookQueue),
    new BullAdapter(aiQueue),
    new BullAdapter(autoReplyQueue),
    new BullAdapter(syncQueue),
    new BullAdapter(notificationQueue)
  ],
  serverAdapter
});

module.exports = serverAdapter;
