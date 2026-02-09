const mongoose = require('mongoose');

const permissionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  code: {
    type: String,
    required: true,
    unique: true
  },
  description: String,
  
  category: {
    type: String,
    enum: ['inbox', 'analytics', 'users', 'settings', 'integrations', 'knowledge_base'],
    required: true
  },
  
  // CRUD permissions
  actions: [{
    type: String,
    enum: ['create', 'read', 'update', 'delete', 'manage']
  }],
  
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
permissionSchema.index({ code: 1 });
permissionSchema.index({ category: 1 });

module.exports = mongoose.model('Permission', permissionSchema);
