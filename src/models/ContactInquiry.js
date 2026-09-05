const mongoose = require('mongoose');

const contactInquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    company: { type: String, trim: true, maxlength: 200, default: '' },
    subject: { type: String, required: true, trim: true, maxlength: 80 },
    message: { type: String, required: true, trim: true, maxlength: 10000 },
    intent: { type: String, trim: true, maxlength: 64 },
    /** YYYY-MM-DD for demo bookings */
    demoDate: { type: String, trim: true, maxlength: 10 },
    /** e.g. "10:30 AM" */
    demoTime: { type: String, trim: true, maxlength: 20 },
    timezone: { type: String, trim: true, maxlength: 64, default: 'Asia/Kolkata' },
    source: { type: String, trim: true, default: 'website', maxlength: 32 },
    ip: { type: String, trim: true, maxlength: 64 },
    userAgent: { type: String, trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

contactInquirySchema.index({ createdAt: -1 });
contactInquirySchema.index({ email: 1 });

module.exports = mongoose.model('ContactInquiry', contactInquirySchema);
