/**
 * One-time migration: fix Instagram comment interactions that have numeric-ID
 * post URLs (e.g. https://www.instagram.com/p/18104377792903993) by resolving
 * the real shortcode permalink via the Instagram Graph API.
 *
 * Usage: node backend/src/scripts/fixInstagramPostUrls.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const GRAPH_BASE = 'https://graph.facebook.com/v18.0';

// Numeric Instagram URL pattern: /p/ followed by 14+ digits only
const NUMERIC_IG_URL_RE = /instagram\.com\/p\/(\d{14,})(?:[/?#]|$)/;

async function fetchPermalink(accessToken, mediaId) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
      params: { fields: 'permalink', access_token: accessToken },
      timeout: 8000
    });
    return res.data?.permalink || null;
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    console.warn(`  ⚠️  fetchPermalink(${mediaId}) failed: ${msg}`);
    return null;
  }
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // Lazy-load models after connect
  const Interaction = require('../models/Interaction');
  const PlatformConnection = require('../models/PlatformConnection');

  // Find all instagram comment interactions with a numeric-looking postUrl
  const broken = await Interaction.find({
    platform: 'instagram',
    type: { $in: ['comment', 'mention'] },
    'metadata.postUrl': { $regex: /\/p\/\d{14,}/ }
  }).select('_id organization metadata').lean();

  console.log(`Found ${broken.length} interaction(s) with broken numeric Instagram URLs.`);
  if (broken.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // Cache connections per org so we don't re-query for every interaction
  const connectionCache = new Map();

  async function getToken(orgId) {
    const key = String(orgId);
    if (connectionCache.has(key)) return connectionCache.get(key);
    const conn = await PlatformConnection.findOne({
      organization: orgId,
      platform: 'instagram',
      status: { $in: ['connected', 'available'] },
      isActive: true
    }).select('accessToken').lean();
    const token = conn?.accessToken || null;
    connectionCache.set(key, token);
    return token;
  }

  let fixed = 0;
  let skipped = 0;

  for (const doc of broken) {
    const postUrl = doc.metadata?.postUrl;
    const mediaId = doc.metadata?.postId || (postUrl && postUrl.match(NUMERIC_IG_URL_RE)?.[1]);

    if (!mediaId) { skipped++; continue; }

    const token = await getToken(doc.organization);
    if (!token) {
      console.warn(`  ⚠️  No Instagram token for org ${doc.organization} — skipping`);
      skipped++;
      continue;
    }

    const permalink = await fetchPermalink(token, mediaId);
    if (!permalink) { skipped++; continue; }

    await Interaction.updateOne(
      { _id: doc._id },
      { $set: { 'metadata.postUrl': permalink } }
    );
    console.log(`  ✅ ${doc._id} → ${permalink}`);
    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}, Skipped: ${skipped}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
