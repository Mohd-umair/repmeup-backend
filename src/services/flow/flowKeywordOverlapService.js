/**
 * flowKeywordOverlapService — design-time keyword-overlap detection.
 *
 * Runtime (flowTriggerRouter.matchesTrigger) enrolls a contact into EVERY active flow
 * whose trigger.keyword matches the inbound text — there is no "first match wins" or
 * "only one flow may own this keyword" rule. That's fine when keywords are distinct,
 * but if two active flows share (or substring-overlap) a keyword, a single customer
 * message fires both, and the customer gets 2+ replies for one message.
 *
 * Decision (finalized with the customer): don't silently allow this at runtime. Instead,
 * surface the conflict at DESIGN TIME — while editing the trigger.keyword node, and again
 * (server-side, so the UI check can't be bypassed) when the flow is activated/published —
 * and require an explicit "Activate anyway" acknowledgement before letting both flows run
 * live with overlapping keywords.
 *
 * The overlap rule below intentionally mirrors matchesTrigger()'s runtime substring check
 * (`text.includes(keyword)`) so design-time warnings and runtime behavior never disagree.
 */
const AutomationFlow = require('../../models/AutomationFlow');

/**
 * Same substring-match semantics as flowTriggerRouter.matchesTrigger() for
 * trigger.keyword, applied to two keyword LISTS instead of one list + one message:
 * true if any keyword in `a` is a substring of (or contains) any keyword in `b`.
 * An empty keyword list matches every inbound message at runtime, so it is treated
 * as overlapping with anything.
 */
function keywordListsOverlap(a = [], b = []) {
  const normA = (a || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  const normB = (b || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  if (normA.length === 0 || normB.length === 0) return true;
  return normA.some((ka) => normB.some((kb) => ka.includes(kb) || kb.includes(ka)));
}

/** All trigger.keyword nodes on a flow, as { nodeId, keywords }. */
function extractKeywordTriggers(flow) {
  return (flow.nodes || [])
    .filter((n) => n.type === 'trigger.keyword')
    .map((n) => ({ nodeId: n.id, keywords: n.config?.keywords || [] }));
}

/** Flattened, de-duplicated, lower-cased keyword list across all of a flow's trigger.keyword nodes. */
function flattenFlowKeywords(flow) {
  const all = extractKeywordTriggers(flow).flatMap((t) => t.keywords);
  return [...new Set(all.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Find every OTHER active, non-blueprint flow (same organization + at least one shared
 * channel) whose trigger.keyword keywords overlap with `keywords`.
 *
 * @returns {Promise<Array<{ flowId: string, flowName: string, keywords: string[] }>>}
 */
async function findOverlappingFlows({ organizationId, channels, keywords, excludeFlowId }) {
  if (!keywords || keywords.length === 0) return [];

  const query = {
    organization: organizationId,
    status: 'active',
    isBlueprint: false,
    channels: { $in: channels && channels.length ? channels : ['whatsapp', 'instagram', 'facebook'] }
  };
  if (excludeFlowId) query._id = { $ne: excludeFlowId };

  const candidates = await AutomationFlow.find(query).select('name nodes channels').lean();

  const conflicts = [];
  for (const flow of candidates) {
    for (const trigger of extractKeywordTriggers(flow)) {
      if (keywordListsOverlap(keywords, trigger.keywords)) {
        conflicts.push({ flowId: String(flow._id), flowName: flow.name, keywords: trigger.keywords });
        break; // one entry per conflicting flow is enough detail for the warning
      }
    }
  }
  return conflicts;
}

/**
 * Decide whether a flow may publish/activate given its current keyword overlap with other
 * active flows, and what (if anything) should be written to `acknowledgedOverlap`. Pure
 * decision logic — no DB writes here; the caller (controller) applies the returned update.
 *
 *   - No overlap: allowed. Clears any stale acknowledgement, so a LATER edit that
 *     reintroduces a conflict must be re-confirmed, not silently covered by an old ack.
 *   - Overlap + already acknowledged for this EXACT keyword set: allowed silently (the user
 *     already made this call and the keywords haven't changed since).
 *   - Overlap + not (yet) acknowledged, and this call didn't pass acknowledgeOverlap: BLOCKED.
 *     Caller must show the conflict to the user and resubmit with acknowledgeOverlap: true.
 *   - Overlap + acknowledgeOverlap: true on this call: allowed, and the acknowledgement is
 *     recorded (audit trail of "activate anyway").
 *
 * @param {object} flow lean AutomationFlow document (must include nodes, channels, _id,
 *   and acknowledgedOverlap)
 * @param {string|ObjectId} organizationId
 * @param {boolean} acknowledgeOverlap  true when the caller has explicitly confirmed
 * @returns {Promise<{ blocked: boolean, conflicts?: Array, acknowledgedOverlapUpdate?: object }>}
 */
async function resolveOverlapForPublish(flow, organizationId, acknowledgeOverlap) {
  const keywords = flattenFlowKeywords(flow);
  if (!keywords.length) return { blocked: false };

  const conflicts = await findOverlappingFlows({
    organizationId,
    channels: flow.channels,
    keywords,
    excludeFlowId: flow._id
  });

  if (!conflicts.length) {
    return {
      blocked: false,
      acknowledgedOverlapUpdate: { flag: false, keywords: [], conflictingFlowIds: [], at: null }
    };
  }

  const ackKeywords = (flow.acknowledgedOverlap?.keywords || []).slice().sort().join('\u0000');
  const currentKeywords = keywords.slice().sort().join('\u0000');
  const alreadyAcknowledgedForTheseKeywords = !!flow.acknowledgedOverlap?.flag && ackKeywords === currentKeywords;

  if (!acknowledgeOverlap && !alreadyAcknowledgedForTheseKeywords) {
    return { blocked: true, conflicts };
  }

  return {
    blocked: false,
    acknowledgedOverlapUpdate: {
      flag: true,
      keywords,
      conflictingFlowIds: conflicts.map((c) => c.flowId),
      at: new Date()
    }
  };
}

module.exports = {
  keywordListsOverlap,
  extractKeywordTriggers,
  flattenFlowKeywords,
  findOverlappingFlows,
  resolveOverlapForPublish
};
