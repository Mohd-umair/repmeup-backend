const mongoose = require('mongoose');

const responseTemplateSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  content: {
    type: String,
    required: true
  },
  
  // Variables that can be used in template: {{name}}, {{product}}, etc.
  variables: [String],
  
  category: {
    type: String,
    trim: true
  },
  
  // When this template is applicable
  applicableFor: {
    platforms: [{
      type: String,
      enum: ['instagram', 'facebook', 'whatsapp', 'youtube', 'google', 'website']
    }],
    types: [{
      type: String,
      enum: ['comment', 'dm', 'review', 'mention']
    }],
    sentiments: [{
      type: String,
      enum: ['positive', 'negative', 'neutral']
    }]
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
  }
}, {
  timestamps: true
});

// Indexes
responseTemplateSchema.index({ organization: 1, isActive: 1 });
responseTemplateSchema.index({ organization: 1, category: 1 });

// Parse variables from content
responseTemplateSchema.pre('save', function(next) {
  if (!this.isModified('content')) {
    return next();
  }
  
  // Extract variables like {{variable_name}}
  const regex = /\{\{(\w+)\}\}/g;
  const matches = [...this.content.matchAll(regex)];
  this.variables = [...new Set(matches.map(m => m[1]))];
  
  next();
});

// Replace variables in template
responseTemplateSchema.methods.render = function(data = {}) {
  let rendered = this.content;
  
  for (const variable of this.variables) {
    const value = data[variable] || '';
    const regex = new RegExp(`\\{\\{${variable}\\}\\}`, 'g');
    rendered = rendered.replace(regex, value);
  }
  
  return rendered;
};

// Increment usage
responseTemplateSchema.methods.incrementUsage = function() {
  this.usageCount += 1;
  this.lastUsedAt = new Date();
  return this.save();
};

module.exports = mongoose.model('ResponseTemplate', responseTemplateSchema);

