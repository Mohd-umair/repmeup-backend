/**
 * Script to fix Instagram post URLs by fetching permalinks
 * Run with: node scripts/fix-instagram-urls.js
 */

const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

// Import models
const ScheduledPost = require('../src/models/ScheduledPost');
const PlatformConnection = require('../src/models/PlatformConnection');

const INSTAGRAM_API_BASE = 'https://graph.facebook.com/v21.0';

async function fixInstagramUrls() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all published Instagram posts with numeric URLs
    const posts = await ScheduledPost.find({
      platform: 'instagram',
      status: 'published',
      platformPostId: { $exists: true },
      platformPostUrl: { $regex: /\/p\/\d+\// } // Match numeric IDs
    }).populate('platformConnection');

    console.log(`📊 Found ${posts.length} Instagram posts with numeric URLs\n`);

    if (posts.length === 0) {
      console.log('✅ All Instagram URLs are already correct!');
      process.exit(0);
    }

    let updated = 0;
    let failed = 0;

    for (const post of posts) {
      try {
        const platformPostId = post.platformPostId;
        const accessToken = post.platformConnection?.accessToken;

        if (!accessToken) {
          console.log(`⚠️  Skipping post ${post._id}: No access token`);
          failed++;
          continue;
        }

        console.log(`🔍 Fetching permalink for post ${platformPostId}...`);

        // Fetch permalink from Instagram API
        const response = await axios.get(
          `${INSTAGRAM_API_BASE}/${platformPostId}`,
          {
            params: {
              access_token: accessToken,
              fields: 'permalink'
            }
          }
        );

        if (response.data.permalink) {
          const oldUrl = post.platformPostUrl;
          const newUrl = response.data.permalink;

          // Update the post
          post.platformPostUrl = newUrl;
          await post.save();

          console.log(`✅ Updated post ${post._id}`);
          console.log(`   Old: ${oldUrl}`);
          console.log(`   New: ${newUrl}\n`);
          updated++;
        } else {
          console.log(`⚠️  No permalink found for post ${platformPostId}\n`);
          failed++;
        }

        // Rate limiting - wait 200ms between requests
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        console.error(`❌ Error processing post ${post._id}:`, error.message);
        if (error.response?.data) {
          console.error('   API Error:', error.response.data);
        }
        console.log('');
        failed++;
      }
    }

    console.log('\n📊 Summary:');
    console.log(`   Total posts processed: ${posts.length}`);
    console.log(`   ✅ Successfully updated: ${updated}`);
    console.log(`   ❌ Failed: ${failed}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run the script
fixInstagramUrls();
