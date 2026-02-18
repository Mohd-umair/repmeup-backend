/**
 * Google Cross-Account Protection (RISC) Stream Registration Script
 *
 * Run this once to register your RISC receiver endpoint with Google.
 *
 * Prerequisites:
 * 1. Download your Google Cloud service account key JSON from:
 *    https://console.developers.google.com/apis/credentials?project=YOUR_PROJECT
 *    (Create credentials → Service account → Role: RISC Configuration Admin)
 * 2. Enable the RISC API at:
 *    https://console.developers.google.com/apis/api/risc.googleapis.com/overview
 * 3. Set GOOGLE_SERVICE_ACCOUNT_KEY env var to the path of your JSON key file,
 *    or set GOOGLE_SERVICE_ACCOUNT_JSON to the JSON string directly.
 * 4. Set BACKEND_URL (e.g. https://api.yourdomain.com)
 *
 * Usage:
 *   node scripts/setup-risc.js [register|status|verify|disable|enable]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const RISC_API_BASE = 'https://risc.googleapis.com/v1beta';
const RISC_MANAGEMENT_AUDIENCE = 'https://risc.googleapis.com/google.identity.risc.v1beta.RiscManagementService';

const EVENT_TYPES = [
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/oauth/event-type/token-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  'https://schemas.openid.net/secevent/risc/event-type/verification',
];

function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyPath) {
    throw new Error(
      'Set GOOGLE_SERVICE_ACCOUNT_KEY (path to JSON file) or GOOGLE_SERVICE_ACCOUNT_JSON (JSON string)'
    );
  }
  return JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
}

function makeBearerToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: RISC_MANAGEMENT_AUDIENCE,
    iat: now,
    exp: now + 3600,
  };
  return jwt.sign(payload, serviceAccount.private_key, {
    algorithm: 'RS256',
    keyid: serviceAccount.private_key_id,
  });
}

async function getAuthToken() {
  const sa = loadServiceAccount();
  return makeBearerToken(sa);
}

function getReceiverEndpoint() {
  const backendUrl = process.env.BACKEND_URL || process.env.API_URL;
  if (!backendUrl) {
    throw new Error('Set BACKEND_URL env variable (e.g. https://api.yourdomain.com)');
  }
  return `${backendUrl}/api/auth/risc/receiver`;
}

async function register() {
  const token = await getAuthToken();
  const receiverEndpoint = getReceiverEndpoint();

  console.log(`\n📡 Registering RISC receiver endpoint: ${receiverEndpoint}\n`);

  const body = {
    delivery: {
      delivery_method: 'https://schemas.openid.net/secevent/risc/delivery-method/push',
      url: receiverEndpoint,
    },
    events_requested: EVENT_TYPES,
  };

  const { data } = await axios.post(`${RISC_API_BASE}/stream:update`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  console.log('✅ RISC stream registered successfully!');
  console.log(JSON.stringify(data, null, 2));
}

async function getStatus() {
  const token = await getAuthToken();
  const { data } = await axios.get(`${RISC_API_BASE}/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('\n📊 Current RISC stream configuration:');
  console.log(JSON.stringify(data, null, 2));
}

async function verify() {
  const token = await getAuthToken();
  const nonce = `test-${Date.now()}`;
  console.log(`\n🔍 Sending verification token with state: ${nonce}`);

  await axios.post(
    `${RISC_API_BASE}/stream:verify`,
    { state: nonce },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  console.log('✅ Verification token sent! Check your receiver endpoint logs for the event.');
}

async function setStreamStatus(status) {
  const token = await getAuthToken();
  await axios.post(
    `${RISC_API_BASE}/stream/status:update`,
    { status },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  console.log(`✅ RISC stream status set to: ${status}`);
}

async function main() {
  const command = process.argv[2] || 'register';

  try {
    switch (command) {
      case 'register':
        await register();
        break;
      case 'status':
        await getStatus();
        break;
      case 'verify':
        await verify();
        break;
      case 'disable':
        await setStreamStatus('disabled');
        break;
      case 'enable':
        await setStreamStatus('enabled');
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node scripts/setup-risc.js [register|status|verify|disable|enable]');
        process.exit(1);
    }
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
    console.error('\n❌ Error:', detail);
    process.exit(1);
  }
}

main();
