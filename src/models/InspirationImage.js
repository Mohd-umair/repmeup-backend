const mongoose = require('mongoose');

const INDUSTRIES = [
  'fashion',
  'restaurant',
  'real_estate',
  'clinic',
  'saas',
  'retail',
  'education',
  'fitness',
  'beauty',
  'hospitality',
  'finance',
  'automotive',
  'other'
];

const inspirationImageSchema = new mongoose.Schema({
  industry: {
    type: String,
    enum: INDUSTRIES,
    required: true,
    index: true
  },
  imageUrl: {
    type: String,
    required: true,
    trim: true
  },
  s3Key: {
    type: String,
    default: null
  },
  tags: [{ type: String, trim: true }],
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

inspirationImageSchema.index({ industry: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('InspirationImage', inspirationImageSchema);
module.exports.INDUSTRIES = INDUSTRIES;
