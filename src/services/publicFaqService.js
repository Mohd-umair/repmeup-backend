const crypto = require('crypto');
const FaqCategory = require('../models/FaqCategory');
const FAQ_SEED_RAW = require('../config/faqSeedDefaults');

const MAX_TITLE = 200;
const MAX_ICON = 120;
const MAX_QUESTION = 500;
const MAX_ANSWER = 12000;
const MAX_ITEMS_PER_CATEGORY = 80;

function sanitizeSlugId(val, fallbackPrefix) {
  const s = String(val || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (s.length > 0) return s;
  return `${fallbackPrefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function toPublicCategory(doc) {
  const items = [...(doc.items || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  return {
    id: doc.categoryId,
    title: doc.title,
    icon: doc.icon,
    items: items.map((it) => ({
      id: it.itemId,
      question: it.question,
      answer: it.answer,
    })),
  };
}

function rawSeedToDocs(rawList) {
  return rawList.map((c, i) => ({
    categoryId: c.id,
    title: String(c.title).slice(0, MAX_TITLE),
    icon: String(c.icon || 'fas fa-circle-question').slice(0, MAX_ICON),
    sortOrder: i,
    items: (c.items || []).map((it, j) => ({
      itemId: it.id,
      question: String(it.question).slice(0, MAX_QUESTION),
      answer: String(it.answer).slice(0, MAX_ANSWER),
      sortOrder: j,
    })),
  }));
}

async function listPublicDto() {
  const rows = await FaqCategory.find().sort({ sortOrder: 1, categoryId: 1 }).lean();
  return rows.map(toPublicCategory);
}

/**
 * Insert bundled defaults when collection is empty (first public hit or explicit seed).
 */
async function seedFromDefaults({ force = false } = {}) {
  if (force) {
    await FaqCategory.deleteMany({});
  }
  const count = await FaqCategory.countDocuments();
  if (count > 0) {
    return { inserted: false, reason: 'already_exists' };
  }
  const docs = rawSeedToDocs(FAQ_SEED_RAW);
  await FaqCategory.insertMany(docs);
  return { inserted: true, reason: 'seeded' };
}

/**
 * Replace FAQ set from super-admin payload.
 * Body shape: { categories: [{ id, title, icon, items: [{ id, question, answer }] }] }
 */
async function syncCategories(categoriesInput) {
  if (!Array.isArray(categoriesInput) || categoriesInput.length === 0) {
    const err = new Error('categories must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }

  const normalized = [];
  const seenCat = new Set();
  const seenItemKeys = new Set();

  categoriesInput.forEach((c, catIndex) => {
    const categoryId = sanitizeSlugId(c.id, `category-${catIndex}`);
    if (seenCat.has(categoryId)) {
      const err = new Error(`Duplicate category id: ${categoryId}`);
      err.statusCode = 400;
      throw err;
    }
    seenCat.add(categoryId);

    const title = String(c.title || '').trim().slice(0, MAX_TITLE);
    const icon = String(c.icon || 'fas fa-circle-question').trim().slice(0, MAX_ICON);
    if (!title) {
      const err = new Error(`Category ${categoryId}: title is required`);
      err.statusCode = 400;
      throw err;
    }

    const itemsRaw = Array.isArray(c.items) ? c.items : [];
    if (itemsRaw.length > MAX_ITEMS_PER_CATEGORY) {
      const err = new Error(`Category ${categoryId}: too many items (max ${MAX_ITEMS_PER_CATEGORY})`);
      err.statusCode = 400;
      throw err;
    }

    const items = itemsRaw.map((it, j) => {
      const itemId = sanitizeSlugId(it.id, `item-${catIndex}-${j}`);
      const key = `${categoryId}:${itemId}`;
      if (seenItemKeys.has(key)) {
        const err = new Error(`Duplicate item id in category ${categoryId}: ${itemId}`);
        err.statusCode = 400;
        throw err;
      }
      seenItemKeys.add(key);
      const question = String(it.question || '').trim().slice(0, MAX_QUESTION);
      const answer = String(it.answer || '').trim().slice(0, MAX_ANSWER);
      if (!question || !answer) {
        const err = new Error(`Category ${categoryId}, item ${itemId}: question and answer are required`);
        err.statusCode = 400;
        throw err;
      }
      return {
        itemId,
        question,
        answer,
        sortOrder: j,
      };
    });

    normalized.push({
      categoryId,
      title,
      icon,
      sortOrder: catIndex,
      items,
    });
  });

  const keepIds = normalized.map((n) => n.categoryId);
  await FaqCategory.deleteMany({ categoryId: { $nin: keepIds } });

  for (let i = 0; i < normalized.length; i += 1) {
    const n = normalized[i];
    await FaqCategory.findOneAndUpdate(
      { categoryId: n.categoryId },
      {
        $set: {
          title: n.title,
          icon: n.icon,
          sortOrder: n.sortOrder,
          items: n.items,
        },
      },
      { upsert: true, new: true, runValidators: true }
    );
  }

  return listPublicDto();
}

module.exports = {
  toPublicCategory,
  listPublicDto,
  seedFromDefaults,
  syncCategories,
  rawSeedToDocs,
  FAQ_SEED_RAW,
};
