/**
 * Welcome / first-time signup email — table-based layout for broad client support.
 */

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} opts
 * @param {string} opts.firstName
 * @param {string|null} opts.tempPassword
 * @param {string} opts.loginUrl
 * @param {string} opts.dashboardUrl
 * @param {string} opts.appName
 */
function buildWelcomeSignupEmail(opts) {
  const firstName = escapeHtml(opts.firstName || 'there');
  const appName = escapeHtml(opts.appName || 'RepMeUp');
  const loginUrl = escapeHtml(opts.loginUrl);
  const dashboardUrl = escapeHtml(opts.dashboardUrl);
  const tempPassword = opts.tempPassword ? escapeHtml(String(opts.tempPassword)) : null;

  const tempBlock = tempPassword
    ? `
<tr>
  <td style="padding:0 40px 24px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:12px;background-color:#111827;border:1px solid #374151;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#D8FF00;text-transform:uppercase;letter-spacing:0.06em;">Your temporary password</p>
          <p style="margin:0 0 12px 0;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:18px;font-weight:bold;color:#F9FAFB;word-break:break-all;">${tempPassword}</p>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#9CA3AF;">Sign in once, then change this password under your profile settings.</p>
        </td>
      </tr>
    </table>
  </td>
</tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to ${appName}</title>
</head>
<body style="margin:0;padding:0;background-color:#E5E7EB;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:transparent;">
    You joined ${appName} — one inbox for every conversation. Open your account to get started.
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#E5E7EB;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <!-- Top accent -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#D8FF00 0%,#9FE870 50%,#D8FF00 100%);background-color:#D8FF00;"></td>
          </tr>
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px 40px;background-color:#0B0B0B;">
              <p style="margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#D8FF00;text-transform:uppercase;letter-spacing:0.14em;">Welcome aboard</p>
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.2;font-weight:800;color:#FFFFFF;">Hi ${firstName}, you're in.</h1>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#9CA3AF;">Your ${appName} account is ready. Manage every comment, DM, and review from one place — with Reppy that matches your brand.</p>
            </td>
          </tr>
          <!-- CTA -->
          <tr>
            <td style="padding:8px 40px 28px 40px;background-color:#0B0B0B;">
              <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                <td style="border-radius:10px;background-color:#D8FF00;">
                  <a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#0B0B0B;text-decoration:none;border-radius:10px;">Open your dashboard</a>
                </td>
              </tr></table>
              <p style="margin:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6B7280;">
                Prefer to sign in again? <a href="${loginUrl}" style="color:#D8FF00;font-weight:600;text-decoration:underline;">Log in here</a>
              </p>
            </td>
          </tr>
          <!-- Body light -->
          <tr>
            <td style="padding:28px 40px 8px 40px;background-color:#FFFFFF;">
              <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#111827;">Start in three steps</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align:top;width:36px;padding:0 0 16px 0;">
                    <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background-color:#F0FDF4;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#166534;">1</span>
                  </td>
                  <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#4B5563;"><strong style="color:#111827;">Sign in</strong> — Use the email you registered with${tempPassword ? ' and the temporary password above' : ''}.</td>
                </tr>
                <tr>
                  <td style="vertical-align:top;width:36px;padding:0 0 16px 0;">
                    <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background-color:#F0FDF4;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#166534;">2</span>
                  </td>
                  <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#4B5563;"><strong style="color:#111827;">Connect platforms</strong> — Link Instagram, Facebook, WhatsApp, and more under Settings.</td>
                </tr>
                <tr>
                  <td style="vertical-align:top;width:36px;padding:0 0 16px 0;">
                    <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background-color:#F0FDF4;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#166534;">3</span>
                  </td>
                  <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#4B5563;"><strong style="color:#111827;">Open the inbox</strong> — Reply faster with Reppy suggestions and team assignments.</td>
                </tr>
              </table>
            </td>
          </tr>
          ${tempBlock}
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px 32px 40px;background-color:#F9FAFB;border-top:1px solid #E5E7EB;">
              <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6B7280;">You're receiving this because an account was created with this email on ${appName}.</p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9CA3AF;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildWelcomeSignupPlainText(opts) {
  const name = opts.firstName || 'there';
  const app = opts.appName || 'RepMeUp';
  const lines = [
    `Hi ${name},`,
    '',
    `Welcome to ${app}! Your account is ready.`,
    '',
    `Open your dashboard: ${opts.dashboardUrl}`,
    `Log in: ${opts.loginUrl}`
  ];
  if (opts.tempPassword) {
    lines.push('', `Temporary password: ${opts.tempPassword}`, 'Please change it after your first login.');
  }
  lines.push('', '— The ' + app + ' team');
  return lines.join('\n');
}

module.exports = {
  buildWelcomeSignupEmail,
  buildWelcomeSignupPlainText
};
