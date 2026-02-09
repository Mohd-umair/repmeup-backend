require('dotenv').config();
const mongoose = require('mongoose');
const Interaction = require('../src/models/Interaction');
const aiService = require('../src/services/aiService');

/**
 * Bulk analyze sentiment for interactions that have no sentiment
 * Uses keyword-based fallback (no AI/Ollama needed)
 */

async function analyzeSentimentBulk() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find interactions with no sentiment
    const interactions = await Interaction.find({
      $or: [
        { sentiment: { $exists: false } },
        { sentiment: null },
        { sentiment: '' }
      ]
    })
      .limit(1000)
      .lean();

    console.log(`📊 Found ${interactions.length} interactions with no sentiment\n`);

    if (interactions.length === 0) {
      console.log('✅ All interactions already have sentiment!');
      await mongoose.disconnect();
      return;
    }

    let analyzed = 0;
    const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
    const sample = [];

    for (const doc of interactions) {
      const content = doc.content || '';
      if (!content.trim()) {
        console.log(`⏭️  Skipping empty content (ID: ${doc._id})`);
        continue;
      }

      // Use keyword-based fallback sentiment (no AI needed)
      const result = aiService.fallbackSentimentAnalysis(content);

      await Interaction.updateOne(
        { _id: doc._id },
        {
          $set: {
            sentiment: result.sentiment,
            sentimentScore: result.sentimentScore,
            sentimentConfidence: result.sentimentConfidence
          }
        }
      );

      analyzed++;
      sentimentCounts[result.sentiment]++;

      // Collect sample for display
      if (sample.length < 10) {
        sample.push({
          platform: doc.platform,
          content: content.substring(0, 60),
          sentiment: result.sentiment,
          score: result.sentimentScore
        });
      }

      // Progress indicator
      if (analyzed % 50 === 0) {
        console.log(`   ... analyzed ${analyzed}/${interactions.length}`);
      }
    }

    console.log(`\n✅ Sentiment analysis complete!\n`);
    console.log(`📊 Results:`);
    console.log(`   Total analyzed: ${analyzed}`);
    console.log(`   Positive: ${sentimentCounts.positive}`);
    console.log(`   Negative: ${sentimentCounts.negative}`);
    console.log(`   Neutral: ${sentimentCounts.neutral}`);

    console.log(`\n📋 Sample results:\n`);
    sample.forEach((s, i) => {
      const emoji = s.sentiment === 'positive' ? '😊' : s.sentiment === 'negative' ? '😟' : '😐';
      console.log(`   ${i + 1}. [${s.platform}] ${emoji} ${s.sentiment} (${s.score.toFixed(2)})`);
      console.log(`      "${s.content}${s.content.length >= 60 ? '...' : ''}"`);
    });

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
    console.log('\n🎉 Now refresh your Inbox and try the Positive/Negative/Neutral filters!');
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

// Run the script
analyzeSentimentBulk();
