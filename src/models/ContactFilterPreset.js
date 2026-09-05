const mongoose = require('mongoose');

const filterConditionSchema = new mongoose.Schema({
  field: { type: String },
  operator: { type: String },
  value: { type: mongoose.Schema.Types.Mixed },
  logic: { type: String, enum: ['AND', 'OR'] },
  conditions: { type: [mongoose.Schema.Types.Mixed], default: undefined }
}, { _id: false, strict: false });

const contactFilterPresetSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  kind: { type: String, enum: ['saved_view', 'segment'], required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 400, default: '' },
  filterQuery: {
    logic: { type: String, enum: ['AND', 'OR'], default: 'AND' },
    conditions: { type: [filterConditionSchema], default: [] }
  },
  sort: {
    field: { type: String, default: 'lastInteractionAt' },
    dir: { type: String, enum: ['asc', 'desc'], default: 'desc' }
  },
  columns: [{ type: String }],
  color: { type: String, default: null },
  icon: { type: String, default: null },
  isSystem: { type: Boolean, default: false },
  memberCountCached: { type: Number, default: 0 },
  lastEvaluatedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

contactFilterPresetSchema.index({ organization: 1, kind: 1, name: 1 });

module.exports = mongoose.model('ContactFilterPreset', contactFilterPresetSchema);
