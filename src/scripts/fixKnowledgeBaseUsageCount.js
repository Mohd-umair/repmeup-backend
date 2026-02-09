/**
 * Fix KnowledgeBase documents with invalid usageCount (NaN, null, undefined)
 * Run this script once to clean up existing data
 * 
 * Usage: node backend/src/scripts/fixKnowledgeBaseUsageCount.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeBase = require('../models/KnowledgeBase');

async function fixUsageCount() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all documents with invalid usageCount
    const invalidDocs = await KnowledgeBase.find({
      $or: [
        { usageCount: { $exists: false } },
        { usageCount: null },
        { usageCount: NaN },
        { usageCount: { $type: 'string' } }
      ]
    });

    console.log(`Found ${invalidDocs.length} documents with invalid usageCount`);

    // Fix each document
    let fixed = 0;
    for (const doc of invalidDocs) {
      try {
        // Set usageCount to 0 if invalid
        if (typeof doc.usageCount !== 'number' || isNaN(doc.usageCount) || doc.usageCount === null) {
          doc.usageCount = 0;
          await doc.save();
          fixed++;
          console.log(`✅ Fixed document: ${doc._id} (${doc.title})`);
        }
      } catch (error) {
        console.error(`❌ Error fixing document ${doc._id}:`, error.message);
      }
    }

    console.log(`\n✅ Fixed ${fixed} out of ${invalidDocs.length} documents`);
    console.log('✅ Cleanup complete!');

    // Also update any documents where usageCount might be a string
    const stringDocs = await KnowledgeBase.find({
      usageCount: { $type: 'string' }
    });

    if (stringDocs.length > 0) {
      console.log(`\nFound ${stringDocs.length} documents with string usageCount`);
      let fixedStrings = 0;
      
      for (const doc of stringDocs) {
        try {
          const numValue = parseInt(doc.usageCount, 10);
          if (!isNaN(numValue)) {
            doc.usageCount = numValue;
            await doc.save();
            fixedStrings++;
          } else {
            doc.usageCount = 0;
            await doc.save();
            fixedStrings++;
          }
        } catch (error) {
          console.error(`❌ Error fixing string usageCount for ${doc._id}:`, error.message);
        }
      }
      
      console.log(`✅ Fixed ${fixedStrings} documents with string usageCount`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the fix
fixUsageCount();

