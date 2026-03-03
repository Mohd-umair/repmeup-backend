const mongoose = require('mongoose');

/**
 * Audit log for enterprise: post approvals, brand config changes, etc.
 */
const auditLogSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  entity: {
    type: String,
    required: true,
    enum: ['post', 'brand_config', 'organization'],
    index: true
  },
  entityId: {
    type: String,
    index: true
  },
  action: {
    type: String,
    required: true,
    enum: ['approved', 'rejected', 'scheduled', 'created', 'updated', 'deleted'],
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true
});

auditLogSchema.index({ organization: 1, createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
