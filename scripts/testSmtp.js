/**
 * SMTP connectivity + credential test.
 *
 * Verifies the SMTP login using the values in .env (no email is sent unless you
 * pass a recipient). Use this to pinpoint a 535 "Authentication Failed" without
 * guessing.
 *
 *   node scripts/testSmtp.js                 # verify login only
 *   node scripts/testSmtp.js you@example.com # verify + send a real test email
 *
 * Override host/port/creds for a one-off try without editing .env:
 *   SMTP_HOST=smtp.office365.com SMTP_PORT=587 node scripts/testSmtp.js
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const trim = (v, fb = '') => (v == null ? fb : String(v).trim());

const host = trim(process.env.SMTP_HOST, 'smtpout.secureserver.net');
const port = parseInt(trim(process.env.SMTP_PORT, '465'), 10) || 465;
const user = trim(process.env.SMTP_USER);
const pass = trim(process.env.SMTP_PASS);
const secureEnv = trim(process.env.SMTP_SECURE).toLowerCase();
const secure = secureEnv ? secureEnv === 'true' : port === 465;
const legacyCiphers =
  trim(process.env.SMTP_LEGACY_CIPHERS) === 'true' || /secureserver\.net$/i.test(host);

console.log('── SMTP config under test ─────────────────────────────');
console.log('  host   :', host);
console.log('  port   :', port, secure ? '(implicit TLS)' : '(STARTTLS)');
console.log('  user   :', user || '(EMPTY!)');
console.log('  pass   :', pass ? `${'*'.repeat(Math.max(0, pass.length - 2))}${pass.slice(-2)} (len ${pass.length})` : '(EMPTY!)');
console.log('  ciphers:', legacyCiphers ? 'SSLv3 (legacy)' : 'default');
console.log('───────────────────────────────────────────────────────');

if (!user || !pass) {
  console.error('❌ SMTP_USER or SMTP_PASS is empty in .env — nothing to test.');
  process.exit(1);
}

const options = { host, port, secure, requireTLS: !secure, auth: { user, pass }, logger: true, debug: true };
if (legacyCiphers) options.tls = { ciphers: 'SSLv3' };

const transporter = nodemailer.createTransport(options);

(async () => {
  try {
    await transporter.verify();
    console.log('\n✅ SMTP login OK — credentials and server accept this connection.');

    const to = process.argv[2];
    if (to) {
      const info = await transporter.sendMail({
        from: `${process.env.FROM_NAME || 'RepMeUp'} <${process.env.FROM_EMAIL || user}>`,
        to,
        subject: 'RepMeUp SMTP test ✔',
        text: 'If you received this, SMTP sending works.'
      });
      console.log(`✅ Test email sent to ${to} (messageId: ${info.messageId})`);
    } else {
      console.log('ℹ️  Pass a recipient to also send a real email: node scripts/testSmtp.js you@example.com');
    }
    process.exit(0);
  } catch (err) {
    console.error('\n❌ SMTP test FAILED:', err.responseCode || err.code || '', err.response || err.message);
    if (err.responseCode === 535 || err.code === 'EAUTH') {
      console.error(
        '\n535 = the server rejected this username/password. Most likely one of:\n' +
        '  A) The password in .env is not the mailbox password. Log into webmail with the\n' +
        '     EXACT same user + password to confirm:\n' +
        '       • Workspace Email → https://email.secureserver.net\n' +
        '       • Microsoft 365   → https://outlook.office.com\n' +
        '  B) The mailbox is on Microsoft 365, not Workspace Email. Then use:\n' +
        '       SMTP_HOST=smtp.office365.com  SMTP_PORT=587  SMTP_SECURE=false\n' +
        '     and enable SMTP AUTH for the mailbox in the M365 admin (it is off by default);\n' +
        '     if MFA is on, create an APP PASSWORD and use that as SMTP_PASS.\n' +
        '  C) Try the other auth method: SMTP_AUTH_METHOD=LOGIN\n'
      );
    }
    process.exit(1);
  }
})();
