const mongoose = require('mongoose');

const assignmentRuleSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  conditions: { type: mongoose.Schema.Types.Mixed, default: {} },
  action: {
    type: { type: String, enum: ['assign_team', 'assign_user'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true }
  },
  priority: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

assignmentRuleSchema.index({ organization: 1, isActive: 1, priority: -1 });

module.exports = mongoose.model('AssignmentRule', assignmentRuleSchema);
