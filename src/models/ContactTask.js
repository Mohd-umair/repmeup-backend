const mongoose = require('mongoose');

const contactTaskSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000, default: '' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dueDate: { type: Date, default: null },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  status: { type: String, enum: ['open', 'in_progress', 'done', 'cancelled'], default: 'open', index: true },
  relatedCampaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

contactTaskSchema.index({ organization: 1, contact: 1, status: 1, dueDate: 1 });

module.exports = mongoose.model('ContactTask', contactTaskSchema);
