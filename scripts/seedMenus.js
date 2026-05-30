const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const Menu = require('../src/models/Menu');

const defaultMenus = [
  {
    label: 'Home',
    icon: '🏠',
    route: '/',
    order: 1,
    group: 'main',
    requiredRoles: [],
    isActive: true
  },
  {
    label: 'Dashboard',
    icon: '📊',
    route: '/app/dashboard',
    order: 2,
    group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'],
    isActive: true
  },
  {
    label: 'Inbox',
    icon: '📥',
    route: '/app/inbox',
    order: 3,
    group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'],
    badge: {
      enabled: true,
      source: 'inbox'
    },
    isActive: true,
    description: 'View and respond to customer interactions'
  },
  {
    label: 'Bucket Board',
    icon: 'fas fa-columns',
    route: '/app/inbox/buckets',
    order: 4,
    group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'],
    requiredPermissions: ['inbox.read'],
    isActive: true,
    description: 'Intent bucket kanban board for conversations'
  },
  {
    label: 'Publish',
    icon: '✈️',
    route: '/app/publish',
    order: 5,
    group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'],
    isActive: true
  },
  {
    label: 'Knowledge Base',
    icon: '🧠',
    route: '/app/knowledge-base',
    order: 5,
    group: 'main',
    requiredRoles: ['admin', 'manager'],
    requiresFeature: 'knowledge_base',
    isActive: true
  },
  {
    label: 'Analytics',
    icon: '📈',
    route: '/app/analytics',
    order: 6,
    group: 'main',
    requiredRoles: ['admin', 'manager'],
    requiresFeature: 'analytics',
    isActive: true
  },
  {
    label: 'Agents',
    icon: '👥',
    route: '/app/agents',
    order: 7,
    group: 'management',
    requiredRoles: ['admin', 'manager'],
    requiresFeature: 'agents',
    isActive: true
  },
  {
    label: 'Voice IVR',
    icon: 'fas fa-phone-alt',
    route: '/app/voice-ivr',
    order: 8,
    group: 'management',
    requiredRoles: ['admin', 'manager'],
    requiresFeature: 'voice_ivr',
    isActive: true,
    description: 'AI phone calling, voice agents, call logs, analytics'
  },
  {
    label: 'Plans',
    icon: '💎',
    route: '/app/plans',
    order: 8,
    group: 'settings',
    requiredRoles: ['admin', 'manager', 'agent'],
    isActive: true,
    description: 'View and upgrade subscription plans'
  },
  {
    label: 'Settings',
    icon: '⚙️',
    route: '/app/settings',
    order: 9,
    group: 'settings',
    requiredRoles: ['admin', 'manager'],
    isActive: true
  },

];

async function seedMenus() {
  try {
    console.log('🌱 Seeding menus...');

    // Check if menus already exist
    const count = await Menu.countDocuments();
    if (count > 0) {
      console.log('⚠️  Menus already exist. Skipping seed.');
      console.log(`   Current menu count: ${count}`);
      console.log('   To reseed, first delete existing menus:');
      console.log('   db.menus.deleteMany({})');
      process.exit(0);
    }

    // Insert default menus
    const menus = await Menu.insertMany(defaultMenus);

    console.log('✅ Menus seeded successfully!');
    console.log(`   Created ${menus.length} menu items`);
    console.log('\nCreated menus:');
    menus.forEach(menu => {
      console.log(`   - ${menu.label} (${menu.route}) [${menu.requiredRoles.join(', ') || 'public'}]`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding menus:', error);
    process.exit(1);
  }
}

// Run seed
seedMenus();
