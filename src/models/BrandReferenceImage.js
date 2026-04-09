const mongoose = require('mongoose');

const analysisSchema = new mongoose.Schema({
  dominantColors: [{ type: String, trim: true }],
  compositionType: { type: String, trim: true, default: '' },
  textDensity: {
    type: String,
    enum: ['none', 'minimal', 'moderate', 'heavy', ''],
    default: ''
  },
  typographyStyle: { type: String, trim: true, default: '' },
  logoPosition: { type: String, trim: true, default: '' },
  mood: { type: String, trim: true, default: '' },
  layoutPattern: { type: String, trim: true, default: '' }
}, { _id: false });

const brandReferenceImageSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  imageUrl: { type: String, required: true },
  s3Key: { type: String, default: null },
  category: {
    type: String,
    enum: ['general', 'product', 'lifestyle', 'event', 'typography', 'layout'],
    default: 'general'
  },
  tags: [{ type: String, trim: true }],
  analysis: { type: analysisSchema, default: null },
  sortOrder: { type: Number, default: 0 }
}, {
  timestamps: true
});

brandReferenceImageSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model('BrandReferenceImage', brandReferenceImageSchema);
