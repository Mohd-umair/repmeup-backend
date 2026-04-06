const mongoose = require('mongoose');

const faqItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const faqCategorySchema = new mongoose.Schema(
  {
    categoryId: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true },
    icon: { type: String, default: 'fas fa-circle-question' },
    sortOrder: { type: Number, default: 0 },
    items: { type: [faqItemSchema], default: [] },
  },
  { timestamps: true }
);

faqCategorySchema.index({ sortOrder: 1 });

module.exports = mongoose.model('FaqCategory', faqCategorySchema);
