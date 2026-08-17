const mongoose = require('mongoose');

const whatsAppFormFlowSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  templateKey: {
    type: String,
    enum: ['star_rating_comment'],
    default: 'star_rating_comment'
  },
  name: {
    type: String,
    required: true
  },
  description: String,
  customization: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'deprecated'],
    default: 'draft'
  },
  metaFlowId: String,
  metaFlowStatus: String,
  flowJson: mongoose.Schema.Types.Mixed,
  messageTemplateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsAppTemplate'
  },
  templateApprovalStatus: {
    type: String,
    enum: ['pending_approval', 'approved', 'rejected', 'unknown'],
    default: 'unknown'
  },
  publishedAt: Date,
  deprecatedAt: Date,
  stats: {
    sent: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    avgRating: { type: Number, default: null }
  }
}, { timestamps: true });

whatsAppFormFlowSchema.index({ organization: 1, status: 1 });
whatsAppFormFlowSchema.index({ organization: 1, templateKey: 1 });

module.exports = mongoose.model('WhatsAppFormFlow', whatsAppFormFlowSchema);
