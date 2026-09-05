const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  memberUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  roundRobinCursor: { type: Number, default: 0 }
}, { timestamps: true });

teamSchema.index({ organization: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Team', teamSchema);
