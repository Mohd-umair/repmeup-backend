const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/orm', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const Menu = require('../src/models/Menu');

const defaultMenus = [
  { label: 'Home', icon: 'fas fa-home', route: '/', order: 1, group: 'main', requiredRoles: [], isActive: true },
  { label: 'Dashboard', icon: 'fas fa-chart-pie', route: '/app/dashboard', order: 2, group: 'main', requiredRoles: ['admin', 'manager', 'agent'], isActive: true },
  {
    label: 'Inbox', icon: 'fas fa-inbox', route: '/app/inbox', order: 3, group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'],
    badge: { enabled: true, source: 'inbox' }, isActive: true,
    description: 'View and respond to customer interactions'
  },
  {
    label: 'Bucket Board', icon: 'fas fa-columns', route: '/app/inbox/buckets', order: 4, group: 'main',
    requiredRoles: ['admin', 'manager', 'agent'], requiredPermissions: ['inbox.read'], isActive: true,
    description: 'Intent bucket kanban board for conversations'
  },
  { label: 'Publish', icon: 'fas fa-paper-plane', route: '/app/publish', order: 5, group: 'main', requiredRoles: ['admin', 'manager', 'agent'], isActive: true },
  {
    label: 'Knowledge Base', icon: 'fas fa-brain', route: '/app/knowledge-base', order: 5, group: 'main',
    requiredRoles: ['admin', 'manager'], requiresFeature: 'knowledge_base', isActive: true
  },
  {
    label: 'Analytics', icon: 'fas fa-chart-line', route: '/app/analytics', order: 6, group: 'main',
    requiredRoles: ['admin', 'manager'], requiresFeature: 'analytics', isActive: true
  },
  {
    label: 'Agents', icon: 'fas fa-users', route: '/app/agents', order: 7, group: 'management',
    requiredRoles: ['admin', 'manager'], requiresFeature: 'agents', isActive: true
  },
  {
    label: 'Voice IVR', icon: 'fas fa-phone-alt', route: '/app/voice-ivr', order: 8, group: 'management',
    requiredRoles: ['admin', 'manager'], isActive: true,
    description: 'AI phone calling, voice agents, call logs, analytics'
  },
  {
    label: 'Plans', icon: 'fas fa-gem', route: '/app/plans', order: 8, group: 'settings',
    requiredRoles: ['admin', 'manager', 'agent'], isActive: true,
    description: 'View and upgrade subscription plans'
  },
  {
    label: 'Settings', icon: 'fas fa-cog', route: '/app/settings', order: 9, group: 'settings',
    requiredRoles: ['admin', 'manager'], isActive: true
  }
];

async function seedMenus() {
  try {
    console.log('🌱 Seeding menus...');
    const count = await Menu.countDocuments();
    if (count > 0) {
      console.log('⚠️  Menus already exist. Use: npm run seed:menus:force');
      process.exit(0);
    }
    const menus = await Menu.insertMany(defaultMenus);
    console.log(`✅ Created ${menus.length} menu items`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding menus:', error);
    process.exit(1);
  }
}

seedMenus();
