/**
 * WhatsApp Flow Template Definitions
 * Each template provides a builder function that generates Meta's Flow JSON schema.
 * Important: every screen MUST thread flow_token through data outputs so it survives to nfm_reply.
 */

const TEMPLATES = {
  star_rating_comment: {
    name: 'Star Rating + Comment',
    description: 'Collect a star rating and optional comment for post-purchase reviews',
    category: 'SURVEY',
    customizationFields: [
      { name: 'businessName', label: 'Business Name', type: 'text', required: true },
      { name: 'headerText', label: 'Header', type: 'text', default: 'How was your experience?' },
      { name: 'ratingPrompt', label: 'Rating Question', type: 'text', default: 'Please rate your experience' },
      { name: 'commentPrompt', label: 'Comment Question', type: 'text', default: 'Any additional feedback?' },
      { name: 'thankYouText', label: 'Thank You Message', type: 'textarea', default: 'Thank you for your feedback!' }
      // No header image in v1: Flow JSON's Image component takes base64 data, not
      // a URL, so supporting one means fetching + encoding + size-capping it at
      // publish time. Not worth it for a rating form.
    ],
    builder: buildStarRatingCommentFlow
  }
};

/**
 * Flow JSON version every generated flow is stamped with.
 *
 * Meta freezes old versions on a rolling schedule (~12 months active, then
 * frozen — frozen means existing flows keep working but nothing new can be
 * published against it). When publishing starts failing with "Given Flow JSON
 * version is not supported", bump this to the current recommended version:
 * https://developers.facebook.com/docs/whatsapp/flows/changelogs#currently-supported-versions
 */
const FLOW_JSON_VERSION = '7.3';

/**
 * Rating options, best-first. The `id` is what comes back in the flow response,
 * so it must parse cleanly to the 1-5 integer stored on ReviewRequest.rating.
 */
const RATING_OPTIONS = [
  { id: '5', title: 'Excellent' },
  { id: '4', title: 'Good' },
  { id: '3', title: 'Okay' },
  { id: '2', title: 'Poor' },
  { id: '1', title: 'Very poor' }
];

/**
 * Screen titles appear in WhatsApp's own header chrome, which is narrow —
 * Meta rejects long ones, so anything customer-authored gets clamped.
 */
function clampTitle(text, fallback) {
  const value = (text || '').trim() || fallback;
  return value.length > 30 ? `${value.slice(0, 27)}...` : value;
}

/**
 * Build the Star Rating + Comment flow JSON.
 * Customization shape: { businessName, headerText, ratingPrompt, commentPrompt, thankYouText }
 *
 * Schema notes (Meta Flow JSON) — these are easy to get wrong and only surface
 * as validation errors at asset-upload time:
 *   - action key is `on-click-action` (hyphens), and navigate targets
 *     `next: { type: 'screen', name }` — not `next_screen`.
 *   - inputs are identified by `name` and referenced as `${form.<name>}`;
 *     values carried across screens arrive as `${data.<key>}`.
 *   - `complete` is only valid on a screen marked `terminal: true`.
 *   - `data_api_version` is for endpoint-backed flows only; this flow is static
 *     (navigate-only), so including it fails validation.
 *   - `flow_token` is echoed back by Meta on nfm_reply automatically — it must
 *     not be referenced in the payload.
 *   - the `Form` wrapper is optional from version 4.0, but keeping it is what
 *     guarantees `${form.<name>}` resolves, so it stays.
 */
function buildStarRatingCommentFlow(customization = {}) {
  const {
    businessName = 'Business',
    headerText = 'How was your experience?',
    ratingPrompt = 'Please rate your experience',
    commentPrompt = 'Any additional feedback?',
    thankYouText = 'Thank you for your feedback!'
  } = customization;

  return {
    version: FLOW_JSON_VERSION,
    screens: [
      {
        id: 'RATING_SCREEN',
        title: clampTitle(headerText, 'Your feedback'),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form',
              name: 'rating_form',
              children: [
                {
                  type: 'RadioButtonsGroup',
                  name: 'rating',
                  label: ratingPrompt,
                  required: true,
                  'data-source': RATING_OPTIONS
                },
                {
                  type: 'Footer',
                  label: 'Next',
                  'on-click-action': {
                    name: 'navigate',
                    next: { type: 'screen', name: 'COMMENT_SCREEN' },
                    payload: { rating: '${form.rating}' }
                  }
                }
              ]
            }
          ]
        }
      },
      {
        id: 'COMMENT_SCREEN',
        title: clampTitle(businessName, 'Your feedback'),
        // Values handed over by RATING_SCREEN. `__example__` is required by Meta
        // so the editor can render a preview without live data.
        data: {
          rating: { type: 'string', __example__: '5' }
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'Form',
              name: 'comment_form',
              children: [
                {
                  type: 'TextArea',
                  name: 'comment',
                  label: commentPrompt,
                  required: false,
                  // TextArea caps with `max-length`; `max-chars` is TextInput's.
                  'max-length': 500,
                  'helper-text': 'Optional'
                },
                {
                  type: 'Footer',
                  label: 'Next',
                  'on-click-action': {
                    name: 'navigate',
                    next: { type: 'screen', name: 'THANK_YOU_SCREEN' },
                    payload: {
                      rating: '${data.rating}',
                      comment: '${form.comment}'
                    }
                  }
                }
              ]
            }
          ]
        }
      },
      {
        id: 'THANK_YOU_SCREEN',
        title: clampTitle(businessName, 'Thank you'),
        terminal: true,
        data: {
          rating: { type: 'string', __example__: '5' },
          comment: { type: 'string', __example__: 'Great service' }
        },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            {
              type: 'TextHeading',
              text: thankYouText
            },
            {
              type: 'TextBody',
              text: 'Your feedback helps us improve.'
            },
            {
              type: 'Footer',
              label: 'Done',
              'on-click-action': {
                name: 'complete',
                payload: {
                  rating: '${data.rating}',
                  comment: '${data.comment}'
                }
              }
            }
          ]
        }
      }
    ]
  };
}

/**
 * Get a template by key.
 */
function getTemplate(templateKey) {
  if (!TEMPLATES[templateKey]) {
    throw new Error(`Unknown template: ${templateKey}`);
  }
  return TEMPLATES[templateKey];
}

/**
 * List all available templates.
 */
function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, template]) => ({
    key,
    name: template.name,
    description: template.description,
    category: template.category
  }));
}

/**
 * Build flow JSON from customization.
 */
function buildFlowJson(templateKey, customization) {
  const template = getTemplate(templateKey);
  return template.builder(customization);
}

module.exports = {
  TEMPLATES,
  getTemplate,
  listTemplates,
  buildFlowJson
};
