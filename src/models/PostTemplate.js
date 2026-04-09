const mongoose = require('mongoose');

const postTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: {
    type: String,
    enum: ['product_showcase', 'quote', 'announcement', 'behind_the_scenes', 'story_cover', 'custom'],
    default: 'custom'
  },
  description: { type: String, trim: true, default: '' },
  thumbnailUrl: { type: String, default: null },
  aspectRatio: { type: String, default: '1:1' },
  canvasState: { type: mongoose.Schema.Types.Mixed, default: null },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null
  },
  isGlobal: { type: Boolean, default: false }
}, {
  timestamps: true
});

postTemplateSchema.index({ isGlobal: 1, category: 1 });
postTemplateSchema.index({ organization: 1 });

module.exports = mongoose.model('PostTemplate', postTemplateSchema);
