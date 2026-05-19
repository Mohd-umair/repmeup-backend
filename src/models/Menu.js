const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
  label: {
    type: String,
    required: true
  },
  icon: {
    type: String,
    required: true
  },
  route: {
    type: String,
    required: true
  },
  queryParams: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined
  },

  // Permission control
  requiredRoles: [{
    type: String,
    enum: ['admin', 'manager', 'agent', 'viewer'],
    default: []
  }],
  requiredPermissions: [{
    type: String
  }],
  
  // UI properties
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  badge: {
    enabled: Boolean,
    source: {
      type: String,
      enum: ['notifications', 'inbox', 'custom', 'none'],
      default: 'none'
    }
  },
  
  // Grouping
  group: {
    type: String,
    enum: ['main', 'management', 'settings', 'automation'],
    default: 'main'
  },
  
  // Parent menu (for sub-menus)
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Menu',
    default: null
  },
  
  // Metadata
  description: String,
  tooltip: String,
  
  // Feature flags
  requiresFeature: {
    type: String,
    enum: ['analytics', 'agents', 'knowledge_base', 'auto_reply', 'none'],
    default: 'none'
  }
}, {
  timestamps: true
});

// Indexes
menuItemSchema.index({ order: 1, isActive: 1 });
menuItemSchema.index({ group: 1, order: 1 });
menuItemSchema.index({ parentId: 1 });

// Virtual for checking if user has access
menuItemSchema.methods.canAccess = function(user) {
  // Check if menu is active
  if (!this.isActive) return false;
  
  // Check role requirements
  if (this.requiredRoles && this.requiredRoles.length > 0) {
    if (!this.requiredRoles.includes(user.role)) {
      return false;
    }
  }
  
  // Check permission requirements
  if (this.requiredPermissions && this.requiredPermissions.length > 0) {
    if (!user.permissions || !Array.isArray(user.permissions)) {
      return false;
    }
    
    const hasAllPermissions = this.requiredPermissions.every(
      permission => user.permissions.includes(permission)
    );
    
    if (!hasAllPermissions) {
      return false;
    }
  }
  
  return true;
};

module.exports = mongoose.model('Menu', menuItemSchema);
