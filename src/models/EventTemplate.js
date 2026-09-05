const mongoose = require('mongoose');

const eventStyleSchema = new mongoose.Schema({
  dominantColors: [{ type: String, trim: true }],
  decorativeElements: [{ type: String, trim: true }],
  typography: { type: String, trim: true, default: '' },
  layoutPattern: { type: String, trim: true, default: '' },
  mood: { type: String, trim: true, default: '' }
}, { _id: false });

const eventTemplateSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  eventType: {
    type: String,
    enum: [
      'christmas', 'new_year', 'eid', 'ramadan', 'diwali',
      'national_day', 'black_friday', 'cyber_monday', 'valentines',
      'mothers_day', 'fathers_day', 'halloween', 'thanksgiving',
      'custom'
    ],
    required: true
  },
  referenceImageUrl: { type: String, default: null },
  s3Key: { type: String, default: null },
  eventStyle: { type: eventStyleSchema, default: null },
  sampleCaption: { type: String, trim: true, default: '' },
  hashtags: [{ type: String, trim: true }],
  cta: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

eventTemplateSchema.index({ organization: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model('EventTemplate', eventTemplateSchema);
