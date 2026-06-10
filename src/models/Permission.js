const mongoose = require('mongoose');

const CATEGORIES = [
  'inbox', 'analytics', 'users', 'settings', 'integrations',
  'knowledge_base', 'posts', 'media', 'organization', 'billing',
  'accounts'
];

const ACTIONS = ['create', 'read', 'update', 'delete', 'manage', 'export', 'assign'];

const permissionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 100
  },
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 80
  },
  description: {
    type: String,
    trim: true,
    maxlength: 300,
    default: ''
  },
  category: {
    type: String,
    enum: CATEGORIES,
    required: true
  },
  actions: [{
    type: String,
    enum: ACTIONS
  }],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

permissionSchema.index({ category: 1 });

permissionSchema.statics.CATEGORIES = CATEGORIES;
permissionSchema.statics.ACTIONS = ACTIONS;

module.exports = mongoose.model('Permission', permissionSchema);
