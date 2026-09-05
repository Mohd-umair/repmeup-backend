const mongoose = require('mongoose');

const contactActivitySchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: [
      'message_in', 'message_out', 'campaign_sent', 'campaign_delivered', 'campaign_read',
      'campaign_replied', 'campaign_failed', 'note_added', 'task_created', 'task_completed',
      'tag_added', 'tag_removed', 'lifecycle_changed', 'owner_changed', 'order_placed',
      'order_attributed', 'order_paid', 'payment', 'merge', 'import', 'ai_insight', 'automation'
    ]
  },
  channel: { type: String, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  actor: {
    kind: { type: String, enum: ['user', 'ai', 'system'], default: 'system' },
    ref: { type: mongoose.Schema.Types.ObjectId, default: null }
  },
  relatedCampaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
  relatedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceOrder', default: null },
  relatedInteraction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction', default: null },
  idempotencyKey: { type: String, default: null, maxlength: 200 }
}, { timestamps: { createdAt: true, updatedAt: false } });

contactActivitySchema.index({ organization: 1, contact: 1, createdAt: -1 });
contactActivitySchema.index({ organization: 1, relatedCampaign: 1, type: 1 });
contactActivitySchema.index(
  { organization: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('ContactActivity', contactActivitySchema);
