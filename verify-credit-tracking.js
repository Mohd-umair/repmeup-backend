// Verify AI Credit Tracking
const mongoose = require('mongoose');
require('dotenv').config();

async function verifyTracking() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');
    
    const AICreditUsage = require('./src/models/AICreditUsage');
    
    // Check recent credit usage
    console.log('📊 Recent AI Credit Usage (Last 20):\n');
    const recentUsage = await AICreditUsage.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('user', 'name email')
      .populate('organization', 'name')
      .lean();
    
    if (recentUsage.length === 0) {
      console.log('⚠️  No credit usage records found yet.\n');
      console.log('💡 Try:');
      console.log('   1. Create a knowledge base from URL');
      console.log('   2. Trigger an auto-reply\n');
      process.exit(0);
    }
    
    // Group by operation
    const byOperation = {};
    recentUsage.forEach(usage => {
      if (!byOperation[usage.operation]) {
        byOperation[usage.operation] = [];
      }
      byOperation[usage.operation].push(usage);
    });
    
    // Display summary
    console.log('Summary by Operation:\n');
    Object.keys(byOperation).forEach(operation => {
      const count = byOperation[operation].length;
      const totalCredits = byOperation[operation].reduce((sum, u) => sum + u.creditsUsed, 0);
      console.log(`✓ ${operation}: ${count} records, ${totalCredits} credits used`);
    });
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Check for issues
    console.log('🔍 Checking for Issues:\n');
    
    // 1. Check for missing user
    const missingUser = recentUsage.filter(u => !u.user);
    if (missingUser.length > 0) {
      console.log(`❌ ${missingUser.length} record(s) missing user attribution!`);
      missingUser.slice(0, 3).forEach(u => {
        console.log(`   - ${u.operation} (${u.createdAt.toISOString()})`);
      });
    } else {
      console.log('✅ All records have user attribution');
    }
    
    // 2. Check knowledge_base_from_url
    const kbFromUrl = recentUsage.filter(u => u.operation === 'knowledge_base_from_url');
    if (kbFromUrl.length > 0) {
      console.log(`✅ Found ${kbFromUrl.length} knowledge base from URL record(s) with tracking`);
      if (kbFromUrl[0].user) {
        console.log(`   Latest: by ${kbFromUrl[0].user.email || 'Unknown'} (${kbFromUrl[0].metadata?.url || 'N/A'})`);
      }
    } else {
      console.log('ℹ️  No knowledge base from URL usage yet (test this feature)');
    }
    
    // 3. Check auto_reply
    const autoReply = recentUsage.filter(u => u.operation === 'auto_reply');
    if (autoReply.length > 0) {
      console.log(`✅ Found ${autoReply.length} auto-reply record(s) with tracking`);
      if (autoReply[0].user) {
        console.log(`   Latest: attributed to ${autoReply[0].user.email || 'Unknown'} (${autoReply[0].metadata?.platform || 'N/A'})`);
      }
    } else {
      console.log('ℹ️  No auto-reply usage yet (test this feature)');
    }
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // Display detailed recent records
    console.log('📋 Detailed Recent Records:\n');
    recentUsage.slice(0, 10).forEach((usage, index) => {
      console.log(`${index + 1}. ${usage.operation}`);
      console.log(`   User: ${usage.user?.email || 'MISSING! ❌'}`);
      console.log(`   Org: ${usage.organization?.name || 'Unknown'}`);
      console.log(`   Credits: ${usage.creditsUsed}`);
      console.log(`   Time: ${usage.createdAt.toISOString()}`);
      if (usage.metadata && Object.keys(usage.metadata).length > 0) {
        const metaPreview = JSON.stringify(usage.metadata).substring(0, 100);
        console.log(`   Meta: ${metaPreview}${metaPreview.length >= 100 ? '...' : ''}`);
      }
      console.log('');
    });
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

verifyTracking();
