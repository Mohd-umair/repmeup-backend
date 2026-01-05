const mongoose = require('mongoose');

const labelSchema = new mongoose.Schema({
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
  
  color: {
    type: String,
    default: '#3B82F6', // Blue
    match: /^#[0-9A-F]{6}$/i
  },
  
  description: String,
  
  icon: String, // Icon name or emoji
  
  isSystem: {
    type: Boolean,
    default: false // System labels can't be deleted
  },
  
  // Auto-apply rules
  autoApplyRules: [{
    field: {
      type: String,
      enum: ['content', 'sentiment', 'platform', 'type', 'author', 'rating']
    },
    operator: {
      type: String,
      enum: ['contains', 'equals', 'not_equals', 'greater_than', 'less_than', 'starts_with', 'ends_with']
    },
    value: String,
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  
  usageCount: {
    type: Number,
    default: 0
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
labelSchema.index({ organization: 1 });
labelSchema.index({ organization: 1, name: 1 }, { unique: true });

// Increment usage count
labelSchema.methods.incrementUsage = function() {
  this.usageCount += 1;
  return this.save();
};

// Check if rules apply to an interaction
labelSchema.methods.appliesToInteraction = function(interaction) {
  if (!this.autoApplyRules || this.autoApplyRules.length === 0) {
    return false;
  }
  
  for (const rule of this.autoApplyRules) {
    if (!rule.isActive) continue;
    
    const fieldValue = interaction[rule.field]?.toString().toLowerCase() || '';
    const ruleValue = rule.value.toLowerCase();
    
    let matches = false;
    
    switch (rule.operator) {
      case 'contains':
        matches = fieldValue.includes(ruleValue);
        break;
      case 'equals':
        matches = fieldValue === ruleValue;
        break;
      case 'not_equals':
        matches = fieldValue !== ruleValue;
        break;
      case 'starts_with':
        matches = fieldValue.startsWith(ruleValue);
        break;
      case 'ends_with':
        matches = fieldValue.endsWith(ruleValue);
        break;
      case 'greater_than':
        matches = parseFloat(fieldValue) > parseFloat(ruleValue);
        break;
      case 'less_than':
        matches = parseFloat(fieldValue) < parseFloat(ruleValue);
        break;
    }
    
    if (matches) return true;
  }
  
  return false;
};

module.exports = mongoose.model('Label', labelSchema);

