/**
 * Default public FAQ content (seeded into MongoDB; Super Admin can edit in admin panel).
 * Used for DB seeding and super-admin "reset to defaults".
 */
module.exports = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: 'fas fa-rocket',
    items: [
      {
        id: 'what-is-repmeup',
        question: 'What is RepMeUp?',
        answer:
          'RepMeUp is a social media management platform for teams and businesses. You can connect Instagram and Facebook, manage a unified inbox, publish and schedule content, track analytics, and use AI-assisted tools for replies and content—all from one workspace.',
      },
      {
        id: 'how-to-sign-up',
        question: 'How do I create an account?',
        answer:
          'Click Get Started on the home page to register with your email, or use Google sign-in if your organization allows it. After verifying your email, you can complete your profile and connect your first social accounts from Settings.',
      },
      {
        id: 'supported-platforms',
        question: 'Which social platforms does RepMeUp support?',
        answer:
          'RepMeUp focuses on Meta properties: Instagram and Facebook (including pages you manage). Supported surfaces may grow over time; check your Settings → Platforms for the latest connection options.',
      },
      {
        id: 'browser-requirements',
        question: 'What browser should I use?',
        answer:
          'Use an up-to-date version of Chrome, Firefox, Safari, or Edge. Enable cookies and JavaScript. Some publishing and OAuth flows require pop-ups—allow them for RepMeUp when prompted.',
      },
    ],
  },
  {
    id: 'inbox-engagement',
    title: 'Inbox & engagement',
    icon: 'fas fa-inbox',
    items: [
      {
        id: 'unified-inbox',
        question: 'What is the unified inbox?',
        answer:
          'The inbox brings comments and messages from your connected accounts into one queue. You can filter, assign work to teammates, and reply without switching between native apps.',
      },
      {
        id: 'intent-buckets',
        question: 'What are intent buckets?',
        answer:
          'Intent buckets help you organize conversations by theme or workflow (for example support vs. sales). Your admin can configure buckets so messages are easier to route and report on.',
      },
      {
        id: 'auto-reply-ai',
        question: 'How do AI replies and auto-replies work?',
        answer:
          'Depending on your plan and settings, RepMeUp can suggest or automate replies using AI. Usage may count against monthly AI reply or credit limits. Admins configure guardrails in Settings so replies stay on-brand and compliant.',
      },
      {
        id: 'response-time',
        question: 'Will replies show as sent from my brand?',
        answer:
          'Replies are sent through the official APIs using the connected page or profile. The experience matches what Meta allows for that account type. Always confirm connected account permissions in Settings.',
      },
    ],
  },
  {
    id: 'publish-content',
    title: 'Publishing & content',
    icon: 'fas fa-paper-plane',
    items: [
      {
        id: 'schedule-posts',
        question: 'Can I schedule posts in advance?',
        answer:
          'Yes. Use Publish or the calendar to create posts, attach media, pick accounts, and set a publish time. Drafts are saved until you schedule or publish.',
      },
      {
        id: 'drafts-approval',
        question: 'What are drafts and the approval queue?',
        answer:
          'Drafts let you prepare content before it goes live. If your organization uses approvals, posts may need reviewer sign-off from the approval queue before they are scheduled or published.',
      },
      {
        id: 'brand-hub-content-studio',
        question: 'What are Brand Hub and Content Studio?',
        answer:
          'Brand Hub and Content Studio are tools to keep assets and creative workflows organized so your team can produce consistent posts faster. Exact features depend on your plan and permissions.',
      },
      {
        id: 'media-formats',
        question: 'What media can I upload?',
        answer:
          'You can typically upload images and videos subject to Meta’s rules and your plan limits. Very large files or uncommon formats may need to be compressed or converted first.',
      },
    ],
  },
  {
    id: 'knowledge-analytics',
    title: 'Knowledge base & analytics',
    icon: 'fas fa-book',
    items: [
      {
        id: 'knowledge-base-purpose',
        question: 'What is the Knowledge Base for?',
        answer:
          'The Knowledge Base stores approved answers and snippets your team can reuse in support and content. It helps keep messaging consistent and can power AI-assisted suggestions where enabled.',
      },
      {
        id: 'analytics-dashboard',
        question: 'What does Analytics show?',
        answer:
          'Analytics summarizes performance for your connected properties—such as reach, engagement, and content trends—so you can see what resonates. Available metrics depend on data from the platforms and your permissions.',
      },
      {
        id: 'trend-explorer',
        question: 'What is Trend Explorer?',
        answer:
          'Trend Explorer helps you discover topics or patterns relevant to your space so you can plan timely content. Availability may depend on your subscription tier.',
      },
    ],
  },
  {
    id: 'team-permissions',
    title: 'Team, roles & security',
    icon: 'fas fa-users',
    items: [
      {
        id: 'roles-explained',
        question: 'What roles exist in RepMeUp?',
        answer:
          'Organizations typically use roles such as admin, manager, agent, and viewer. Admins manage billing, users, and sensitive settings; managers often oversee workflow; agents handle day-to-day inbox and publishing; viewers may have read-only access. Exact permissions are configured per product area.',
      },
      {
        id: 'invite-teammates',
        question: 'How do I add teammates?',
        answer:
          'Admins (and sometimes managers) can invite users from the Agents or organization settings area. Invites respect your plan’s user limit.',
      },
      {
        id: 'data-security',
        question: 'How is my data protected?',
        answer:
          'RepMeUp uses industry-standard practices for authentication, transport security, and access control. Review our Privacy Policy for details on what we collect and how long it is retained.',
      },
      {
        id: 'password-reset',
        question: 'I forgot my password—what do I do?',
        answer:
          'Use “Forgot password” on the sign-in page. You will receive a link to reset your password. If you use Google-only login, sign in with Google or ask an admin to verify your account setup.',
      },
    ],
  },
  {
    id: 'billing-plans',
    title: 'Plans & billing',
    icon: 'fas fa-credit-card',
    items: [
      {
        id: 'plan-limits',
        question: 'What limits apply to my plan?',
        answer:
          'Plans may cap connected social accounts, team seats, monthly posts, AI replies, and AI credits. You can see live usage and limits under Settings → Plans & Billing (or AI Credits where applicable).',
      },
      {
        id: 'upgrade-plan',
        question: 'How do I upgrade my plan?',
        answer:
          'Admins or billing managers can choose a higher tier from Plans & Billing or the Plans page in the app. Paid upgrades may go through our payment provider; limits usually update right after a successful purchase.',
      },
      {
        id: 'downgrade-cancel',
        question: 'Can I move to a lower paid tier or cancel?',
        answer:
          'Self-serve downgrades between paid tiers are not supported—you can contact support if you need a different arrangement. You can schedule cancellation at the end of your billing period from Plans & Billing; you keep access until the period ends, then your workspace moves to the Free plan.',
      },
      {
        id: 'payment-methods',
        question: 'What payment methods are supported?',
        answer:
          'Online billing is processed securely through our payment partner (for example Razorpay in supported regions). Available methods depend on your country and currency.',
      },
    ],
  },
  {
    id: 'support-help',
    title: 'Support & help',
    icon: 'fas fa-life-ring',
    items: [
      {
        id: 'raise-ticket',
        question: 'How do I contact support?',
        answer:
          'Signed-in users can open Support from the app to raise a ticket with subject, description, and attachments. You can also use the Contact page on this site for general inquiries.',
      },
      {
        id: 'bug-sla',
        question: 'How quickly will you respond?',
        answer:
          'We aim to reply to support tickets and emails as soon as possible. Response times can vary by plan and queue. Include screenshots and steps to reproduce for technical issues.',
      },
      {
        id: 'status-outage',
        question: 'Where can I report outages?',
        answer:
          'Use Support in the app or email us via the Contact page. If Meta or payment providers have an outage, some actions (publishing, inbox) may be delayed until their services recover.',
      },
    ],
  },
];
