const mongoose = require('mongoose');

const customFieldDefinitionSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  key: { type: String, required: true, trim: true, maxlength: 80 },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  type: {
    type: String,
    enum: ['text', 'number', 'date', 'dropdown', 'multiselect', 'boolean', 'currency'],
    required: true
  },
  options: [{ type: String, trim: true }],
  appliesTo: { type: String, enum: ['contact'], default: 'contact' },
  required: { type: Boolean, default: false },
  order: { type: Number, default: 0 }
}, { timestamps: true });

customFieldDefinitionSchema.index({ organization: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('CustomFieldDefinition', customFieldDefinitionSchema);
