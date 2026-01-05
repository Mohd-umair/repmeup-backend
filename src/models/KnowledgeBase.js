const mongoose = require('mongoose');

const knowledgeBaseSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  // Source of knowledge
  source: {
    type: String,
    enum: ['manual', 'pdf', 'url', 'import'],
    required: true,
    default: 'manual'
  },
  
  // Type/Category
  type: {
    type: String,
    enum: ['faq', 'product_info', 'policy', 'brand_voice', 'procedure', 'general'],
    default: 'general'
  },
  
  category: {
    type: String,
    trim: true
  },
  
  title: {
    type: String,
    required: true,
    trim: true
  },
  
  content: {
    type: String,
    required: true
  },
  
  // Tags for better organization
  tags: [String],
  
  keywords: [String], // For search and matching
  
  // Priority/Weight for AI
  priority: {
    type: Number,
    min: 1,
    max: 10,
    default: 5
  },
  
  // AI training specific
  isTrainingData: {
    type: Boolean,
    default: true
  },
  trainingContext: String, // When to use this knowledge
  trainingWeight: {
    type: Number,
    min: 1,
    max: 10,
    default: 5 // Importance score
  },
  
  // Advanced options
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Usage tracking
  usageCount: {
    type: Number,
    default: 0
  },
  lastUsedAt: Date,
  
  isActive: {
    type: Boolean,
    default: true
  },
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
knowledgeBaseSchema.index({ organization: 1, isActive: 1 });
knowledgeBaseSchema.index({ organization: 1, type: 1 });
knowledgeBaseSchema.index({ keywords: 1 });
knowledgeBaseSchema.index({ title: 'text', content: 'text', keywords: 'text' });

// Increment usage
knowledgeBaseSchema.methods.incrementUsage = function() {
  this.usageCount += 1;
  this.lastUsedAt = new Date();
  return this.save();
};

module.exports = mongoose.model('KnowledgeBase', knowledgeBaseSchema);

