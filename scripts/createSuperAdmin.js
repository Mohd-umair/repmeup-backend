/**
 * Create or upgrade a super_admin user for the RepMeUp admin panel.
 * Login is EMAIL + PASSWORD (there is no separate username field).
 *
 * From backend/:
 *
 *   npm run create-super-admin -- --email you@corp.com --password 'SecurePass123'
 *   node scripts/createSuperAdmin.js -e admin@repmeup.com -p 'SecurePass123' --first-name Super --last-name Admin
 *   node scripts/createSuperAdmin.js --help
 *
 * Or use env in .env:
 *   SUPER_ADMIN_EMAIL=
 *   SUPER_ADMIN_PASSWORD=
 *   SUPER_ADMIN_FIRST_NAME=
 *   SUPER_ADMIN_LAST_NAME=
 *
 * Requires: MONGODB_URI in backend/.env
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');

const SUPER_ADMIN_ORG_NAME = 'RepMeUp System';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const getVal = () => {
      if (a.includes('=')) return a.split('=').slice(1).join('=');
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        i++;
        return next;
      }
      return null;
    };

    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a.startsWith('--email=') || a.startsWith('-e=')) {
      out.email = getVal();
    } else if (a === '--email' || a === '-e') {
      out.email = argv[++i] || null;
    } else if (a.startsWith('--username=') || a.startsWith('-u=')) {
      out.email = getVal(); // alias — must still be email for login
    } else if (a === '--username' || a === '-u') {
      out.email = argv[++i] || null;
    } else if (a.startsWith('--password=') || a.startsWith('-p=')) {
      out.password = getVal();
    } else if (a === '--password' || a === '-p') {
      out.password = argv[++i] || null;
    } else if (a.startsWith('--first-name=') || a.startsWith('--firstname=')) {
      out.firstName = getVal();
    } else if (a === '--first-name' || a === '--firstname') {
      out.firstName = argv[++i] || null;
    } else if (a.startsWith('--last-name=') || a.startsWith('--lastname=')) {
      out.lastName = getVal();
    } else if (a === '--last-name' || a === '--lastname') {
      out.lastName = argv[++i] || null;
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Super admin signup (logs in with email + password):

  npm run create-super-admin -- --email you@domain.com --password 'YourSecurePass'

  node scripts/createSuperAdmin.js \\
    --email you@domain.com \\
    --password 'YourSecurePass' \\
    --first-name Super \\
    --last-name Admin

Shortcuts: -e/-p/-u (same value as email for -u).

Env fallback: SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_FIRST_NAME, SUPER_ADMIN_LAST_NAME
`);
}

async function run() {
  const cli = parseArgs(process.argv);

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const explicitPasswordProvided =
    cli.password !== undefined && cli.password !== null && cli.password !== ''
      ? true
      : process.env.SUPER_ADMIN_PASSWORD !== undefined &&
        process.env.SUPER_ADMIN_PASSWORD !== '';

  const password = explicitPasswordProvided
    ? String(cli.password ?? process.env.SUPER_ADMIN_PASSWORD)
    : 'SuperAdmin123!';

  const email = String(cli.email || process.env.SUPER_ADMIN_EMAIL || 'superadmin@repmeup.com')
    .trim()
    .toLowerCase();

  const firstName = String(
    cli.firstName || process.env.SUPER_ADMIN_FIRST_NAME || 'Super'
  ).trim();
  const lastName = String(cli.lastName || process.env.SUPER_ADMIN_LAST_NAME || 'Admin').trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    console.error(
      '❌ Invalid login email (admin uses email + password).\n   Example: --email admin@yourcompany.com\n'
    );
    printHelp();
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('❌ Password must be at least 6 characters.');
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing in backend/.env');
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
      console.log('✅ Using organization:', org.name);
    }

    let user = await User.findOne({ email }).select('+password');

    if (user) {
      user.role = 'super_admin';
      user.firstName = firstName;
      user.lastName = lastName;
      user.organization = org._id;
      user.deletedAt = null;
      user.isActive = true;
      if (explicitPasswordProvided) user.password = password;
      await user.save();
      console.log(
        explicitPasswordProvided
          ? '✅ Updated user → super_admin (password set)'
          : '✅ Updated user → super_admin (password unchanged; use --password to reset)'
      );
      console.log('   ', user.email);
    } else {
      user = await User.create({
        email,
        password,
        firstName,
        lastName,
        role: 'super_admin',
        organization: org._id,
        isActive: true
      });
      console.log('✅ Created super_admin:', user.email);
    }

    console.log('');
    console.log('──────────────── Admin login ────────────────');
    console.log('  Email:   ', email);
    console.log(
      explicitPasswordProvided
        ? '  Password: (value you passed via CLI or SUPER_ADMIN_PASSWORD)'
        : '  Password: SuperAdmin123! — set --password before production deploy'
    );
    console.log('');
  } catch (err) {
    console.error('❌ Error:', err.message || err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

run();
