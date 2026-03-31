/**
 * One-time migration: decode HTML entities in plain-text fields that were stored
 * via validator.escape (e.g. &quot; &#x27; &amp;) so UIs show real quotes again.
 *
 * Run from backend folder:
 *   node scripts/decodeStoredHtmlEntities.js
 *
 * Requires MONGODB_URI in .env (or default local URI).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { decodeHtmlEntities } = require('../src/utils/sanitize');

const KnowledgeBase = require('../src/models/KnowledgeBase');
const ResponseTemplate = require('../src/models/ResponseTemplate');
const Interaction = require('../src/models/Interaction');
const ScheduledPost = require('../src/models/ScheduledPost');
const BrandConfig = require('../src/models/BrandConfig');

function needsDecode(s) {
  return typeof s === 'string' && /&(quot|amp|lt|gt|#x27|#39|apos);/i.test(s);
}

async function run() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/orm';
  await mongoose.connect(uri);
  console.log('Connected. Decoding entities where needed…');

  let kb = 0;
  for await (const doc of KnowledgeBase.find({
    $or: [
      { title: /&/ },
      { content: /&/ },
      { category: /&/ },
      { trainingContext: /&/ },
      { tags: /&/ }
    ]
  }).cursor()) {
    let dirty = false;
    if (needsDecode(doc.title)) {
      doc.title = decodeHtmlEntities(doc.title);
      dirty = true;
    }
    if (needsDecode(doc.content)) {
      doc.content = decodeHtmlEntities(doc.content);
      dirty = true;
    }
    if (doc.category && needsDecode(doc.category)) {
      doc.category = decodeHtmlEntities(doc.category);
      dirty = true;
    }
    if (doc.trainingContext && needsDecode(doc.trainingContext)) {
      doc.trainingContext = decodeHtmlEntities(doc.trainingContext);
      dirty = true;
    }
    if (Array.isArray(doc.tags)) {
      const nextTags = doc.tags.map((t) => (needsDecode(t) ? decodeHtmlEntities(t) : t));
      if (nextTags.some((t, i) => t !== doc.tags[i])) {
        doc.tags = nextTags;
        dirty = true;
      }
    }
    if (dirty) {
      await doc.save();
      kb += 1;
    }
  }
  console.log(`KnowledgeBase documents updated: ${kb}`);

  let rt = 0;
  for await (const doc of ResponseTemplate.find({ $or: [{ name: /&/ }, { content: /&/ }, { category: /&/ }] }).cursor()) {
    let dirty = false;
    if (needsDecode(doc.name)) {
      doc.name = decodeHtmlEntities(doc.name);
      dirty = true;
    }
    if (needsDecode(doc.content)) {
      doc.content = decodeHtmlEntities(doc.content);
      dirty = true;
    }
    if (doc.category && needsDecode(doc.category)) {
      doc.category = decodeHtmlEntities(doc.category);
      dirty = true;
    }
    if (dirty) {
      await doc.save();
      rt += 1;
    }
  }
  console.log(`ResponseTemplate documents updated: ${rt}`);

  let sp = 0;
  for await (const doc of ScheduledPost.find({ content: /&/ }).cursor()) {
    if (needsDecode(doc.content)) {
      doc.content = decodeHtmlEntities(doc.content);
      await doc.save();
      sp += 1;
    }
  }
  console.log(`ScheduledPost documents updated: ${sp}`);

  let ix = 0;
  for await (const doc of Interaction.find({ $or: [{ content: /&/ }, { 'aiSuggestion.content': /&/ }] }).cursor()) {
    let dirty = false;
    if (needsDecode(doc.content)) {
      doc.content = decodeHtmlEntities(doc.content);
      dirty = true;
    }
    if (doc.aiSuggestion?.content && needsDecode(doc.aiSuggestion.content)) {
      doc.aiSuggestion.content = decodeHtmlEntities(doc.aiSuggestion.content);
      dirty = true;
    }
    if (Array.isArray(doc.replies)) {
      for (const r of doc.replies) {
        if (r.content && needsDecode(r.content)) {
          r.content = decodeHtmlEntities(r.content);
          dirty = true;
        }
      }
    }
    if (Array.isArray(doc.internalNotes)) {
      for (const n of doc.internalNotes) {
        if (n.note && needsDecode(n.note)) {
          n.note = decodeHtmlEntities(n.note);
          dirty = true;
        }
      }
    }
    if (Array.isArray(doc.metadata?.incomingMessages)) {
      for (const m of doc.metadata.incomingMessages) {
        if (m.text && needsDecode(m.text)) {
          m.text = decodeHtmlEntities(m.text);
          dirty = true;
        }
      }
    }
    if (dirty) {
      await doc.save();
      ix += 1;
    }
  }
  console.log(`Interaction documents updated: ${ix}`);

  let bc = 0;
  for await (const doc of BrandConfig.find({
    $or: [
      { legalDisclaimers: /&/ },
      { personalityTags: /&/ },
      { bannedWords: /&/ },
      { approvedHashtags: /&/ }
    ]
  }).cursor()) {
    let dirty = false;
    if (doc.legalDisclaimers && needsDecode(doc.legalDisclaimers)) {
      doc.legalDisclaimers = decodeHtmlEntities(doc.legalDisclaimers);
      dirty = true;
    }
    for (const key of ['personalityTags', 'bannedWords', 'approvedHashtags']) {
      if (!Array.isArray(doc[key])) continue;
      const next = doc[key].map((t) => (needsDecode(t) ? decodeHtmlEntities(t) : t));
      if (next.some((t, i) => t !== doc[key][i])) {
        doc[key] = next;
        dirty = true;
      }
    }
    if (dirty) {
      await doc.save();
      bc += 1;
    }
  }
  console.log(`BrandConfig documents updated: ${bc}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
