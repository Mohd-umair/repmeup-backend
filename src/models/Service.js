'use strict';

const mongoose = require('mongoose');

/**
 * Service — a bookable offering for appointment-based businesses (clinics, spas,
 * salons). Distinct from Product (which is a sellable good): a Service has a
 * duration and is delivered by one or more Providers at a scheduled time.
 *
 * Mirrors the lean shape of Product.js so the catalog/management UI feels native.
 */
const serviceSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  category: { type: String, trim: true },

  /** How long one appointment for this service takes. */
  durationMin: { type: Number, required: true, min: 5, default: 30 },

  /** Padding kept free around an appointment (clean-up / prep). */
  bufferBeforeMin: { type: Number, min: 0, default: 0 },
  bufferAfterMin: { type: Number, min: 0, default: 0 },

  price: { type: Number, min: 0, default: 0 },
  currency: { type: String, default: 'INR', trim: true },

  /** Providers qualified to deliver this service. Empty = any active provider. */
  providers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }],

  /** UI accent colour (calendar / chips). */
  color: { type: String, trim: true },

  isActive: { type: Boolean, default: true, index: true }
}, {
  timestamps: true
});

serviceSchema.index({ organization: 1, isActive: 1, name: 1 });

module.exports = mongoose.model('Service', serviceSchema);
