/**
 * Seed Default Plans
 * Run: npm run seed:plans
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Plan = require('../src/models/Plan');

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Default plans configuration
const defaultPlans = [
  {
    planId: 'free',
    name: 'Free',
    description: 'Perfect for individuals getting started with social media management',
    tier: 0,
    price: 0,
    billingCycle: 'monthly',
    // Legacy `limits` retained for backward-compat reads; the engine prefers
    // `entitlements` below.
    limits: {
      maxAccounts: 1,
      maxUsers: 1,
      maxPostsPerMonth: 50,            // capped to creation credits
      maxAutoRepliesPerMonth: 100,
      maxAICreditsPerMonth: 100,
      maxStorageGB: 1,
      maxAPICallsPerDay: 100
    },
    features: [
      'basic_posting',
      'single_inbox',
      'manual_replies',
      'basic_analytics'
    ],
    // Catalog-keyed entitlements per the Free-tier spec. These are the values
    // the new entitlementsService consumes first; legacy `limits` is the
    // back-compat fallback only.
    entitlements: {
      'users.max':                       { limit: 1 },
      'credits.autoReply.monthly':       { limit: 100 },
      'credits.postCreation.monthly':    { limit: 50 },
      'inbox.uniqueContacts.monthly':    { limit: 200 },
      'kb.entries.max':                  { limit: 2 },
      'kb.upload.url':                   { enabled: false },
      'kb.upload.pdf':                   { enabled: true },
      'posts.platforms.maxPerPost':      { limit: 1 },
      'posts.ai.variants.max':           { limit: 2 },
      'posts.trends':                    { enabled: false },
      'posts.logo':                      { enabled: false },
      'posts.saveDraft':                 { enabled: false },
      'inbox.bucket.chat':               { enabled: false },
      'inbox.bucket.create':             { enabled: false }
    },
    isActive: true,
    isPublic: true,
    displayOrder: 1
  },
  {
    planId: 'starter',
    name: 'Starter',
    description: 'Great for small teams and growing businesses',
    tier: 1,
    price: 29,
    billingCycle: 'monthly',
    limits: {
      maxAccounts: 3,
      maxUsers: 2,
      maxPostsPerMonth: 100,
      maxAutoRepliesPerMonth: 500,
      maxAICreditsPerMonth: 500,
      maxStorageGB: 5,
      maxAPICallsPerDay: 1000
    },
    features: [
      'basic_posting',
      'scheduling',
      'analytics_basic',
      'auto_reply',
      'team_collaboration',
      'email_support'
    ],
    isActive: true,
    isPublic: true,
    displayOrder: 2,
    trialDays: 14
  },
  {
    planId: 'pro',
    name: 'Pro',
    description: 'Perfect for professionals and agencies managing multiple clients',
    tier: 2,
    price: 79,
    billingCycle: 'monthly',
    limits: {
      maxAccounts: 10,
      maxUsers: 5,
      maxPostsPerMonth: 500,
      maxAutoRepliesPerMonth: 2000,
      maxAICreditsPerMonth: 2000,
      maxStorageGB: 20,
      maxAPICallsPerDay: 5000
    },
    features: [
      'all_basic',
      'advanced_analytics',
      'ai_responses',
      'knowledge_base',
      'team_collaboration',
      'priority_support',
      'content_calendar',
      'bulk_scheduling',
      'advanced_reporting'
    ],
    badge: 'MOST POPULAR',
    badgeColor: 'blue',
    highlightColor: '#3B82F6',
    isActive: true,
    isPublic: true,
    displayOrder: 3,
    trialDays: 14
  },
  {
    planId: 'business',
    name: 'Business',
    description: 'For large teams and businesses with advanced needs',
    tier: 3,
    price: 199,
    billingCycle: 'monthly',
    limits: {
      maxAccounts: 50,
      maxUsers: 20,
      maxPostsPerMonth: 2000,
      maxAutoRepliesPerMonth: 10000,
      maxAICreditsPerMonth: 10000,
      maxStorageGB: 100,
      maxAPICallsPerDay: 20000
    },
    features: [
      'all_pro',
      'custom_branding',
      'api_access',
      'priority_support',
      'advanced_automation',
      'custom_workflows',
      'dedicated_account_manager',
      'sla_guarantee',
      'advanced_security',
      'audit_logs'
    ],
    badge: 'BEST VALUE',
    badgeColor: 'purple',
    highlightColor: '#8B5CF6',
    isActive: true,
    isPublic: true,
    displayOrder: 4,
    trialDays: 30
  },
  {
    planId: 'enterprise',
    name: 'Enterprise',
    description: 'Custom solutions for enterprises with unique requirements',
    tier: 4,
    price: 'custom',
    billingCycle: 'custom',
    limits: {
      maxAccounts: -1,
      maxUsers: -1,
      maxPostsPerMonth: -1,
      maxAutoRepliesPerMonth: -1,
      maxAICreditsPerMonth: -1,
      maxStorageGB: -1,
      maxAPICallsPerDay: -1
    },
    features: [
      'all_business',
      'dedicated_support',
      'sla',
      'white_label',
      'custom_integrations',
      'on_premise_deployment',
      'custom_development',
      'dedicated_infrastructure',
      'compliance_certifications',
      '24_7_phone_support'
    ],
    badge: 'CONTACT SALES',
    badgeColor: 'indigo',
    highlightColor: '#6366F1',
    isActive: true,
    isPublic: true,
    displayOrder: 5
  }
];

async function seedPlans() {
  try {
    await connectDB();
    
    console.log('🌱 Seeding plans...');

    // Check if plans already exist
    const count = await Plan.countDocuments();
    if (count > 0) {
      console.log('⚠️  Plans already exist in database.');
      console.log(`   Current plan count: ${count}`);
      console.log('\n   Options:');
      console.log('   1. To reseed, first delete existing plans:');
      console.log('      db.plans.deleteMany({})');
      console.log('   2. Or use the update script to modify existing plans');
      process.exit(0);
    }

    // Insert default plans
    const plans = await Plan.insertMany(defaultPlans);

    console.log('✅ Plans seeded successfully!');
    console.log(`   Created ${plans.length} plans\n`);
    
    console.log('📋 Plans created:');
    plans.forEach(plan => {
      const priceDisplay = plan.price === 0 ? 'Free' : 
                          plan.price === 'custom' ? 'Custom' : 
                          `$${plan.price}/mo`;
      console.log(`   - ${plan.name.padEnd(12)} (${plan.planId.padEnd(10)}) - ${priceDisplay.padEnd(12)} - Tier ${plan.tier}`);
      console.log(`     Limits: ${plan.limits.maxAccounts === -1 ? '∞' : plan.limits.maxAccounts} accounts, ${plan.limits.maxUsers === -1 ? '∞' : plan.limits.maxUsers} users`);
      console.log(`     Features: ${plan.features.length} features`);
      if (plan.badge) {
        console.log(`     Badge: ${plan.badge}`);
      }
      console.log('');
    });

    console.log('🎉 Done! Plans are now ready for use.');
    console.log('\n📝 Next steps:');
    console.log('   1. Update Subscription model to reference these plans');
    console.log('   2. Create super admin endpoints to manage plans');
    console.log('   3. Build admin UI for plan management\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding plans:', error);
    process.exit(1);
  }
}

// Run seed
seedPlans();
