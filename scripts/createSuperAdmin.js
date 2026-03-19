/**
 * Create a super admin user in the database.
 * Run from backend folder: node scripts/createSuperAdmin.js
 *
 * Set in .env (or pass inline):
 *   SUPER_ADMIN_EMAIL=admin@repmeup.com
 *   SUPER_ADMIN_PASSWORD=YourSecurePassword123
 *   SUPER_ADMIN_FIRST_NAME=Super
 *   SUPER_ADMIN_LAST_NAME=Admin
 *
 * If SUPER_ADMIN_PASSWORD is not set, a default is used (change after first login in production).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');

const SUPER_ADMIN_ORG_NAME = 'RepMeUp System';

async function run() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@repmeup.com';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin123!';
  const firstName = process.env.SUPER_ADMIN_FIRST_NAME || 'Super';
  const lastName = process.env.SUPER_ADMIN_LAST_NAME || 'Admin';

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set. Set it in .env or environment.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }

  try {
    let org = await Organization.findOne({ name: SUPER_ADMIN_ORG_NAME });
    if (!org) {
      org = await Organization.create({
        name: SUPER_ADMIN_ORG_NAME,
        owner: null,
        subscription: { plan: 'free', status: 'trial', startDate: new Date() }
      });
      console.log('✅ Created organization:', org.name);
    } else {
      console.log('✅ Using existing organization:', org.name);
    }

    let user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (user) {
      user.role = 'super_admin';
      user.firstName = firstName;
      user.lastName = lastName;
      user.organization = org._id;
      if (password && password !== 'SuperAdmin123!') {
        user.password = password;
      }
      await user.save();
      console.log('✅ Updated existing user to super_admin:', user.email);
    } else {
      user = await User.create({
        email: email.toLowerCase(),
        password,
        firstName,
        lastName,
        role: 'super_admin',
        organization: org._id,
        isActive: true
      });
      console.log('✅ Created super admin user:', user.email);
    }

    console.log('');
    console.log('Super admin login:');
    console.log('  Email:', user.email);
    console.log('  Password: (the one you set in SUPER_ADMIN_PASSWORD or default)');
    if (!process.env.SUPER_ADMIN_PASSWORD) {
      console.log('  Default password: SuperAdmin123! (change in production)');
    }
    console.log('');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

run();
