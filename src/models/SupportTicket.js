const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    type: { type: String, trim: true, maxlength: 100 }
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    category: {
      type: String,
      enum: ['bug', 'feature_request', 'billing', 'general'],
      required: true
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10000
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'resolved', 'closed'],
      default: 'open'
    },
    attachments: [attachmentSchema],
    adminNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: ''
    },
    resolvedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

supportTicketSchema.index({ organization: 1, status: 1 });
supportTicketSchema.index({ raisedBy: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
