const Organization = require('../models/Organization');

/**
 * Atomically increments the org's chatCounter and returns a formatted chat reference.
 * The $inc is atomic so concurrent webhooks never receive the same number.
 *
 * @param {string|ObjectId} organizationId
 * @returns {Promise<{chatNumber: number, chatRef: string}>}  e.g. { chatNumber: 101, chatRef: '#REP-101' }
 */
async function generateChatRef(organizationId) {
  const org = await Organization.findByIdAndUpdate(
    organizationId,
    { $inc: { chatCounter: 1 } },
    { new: true, select: 'chatCounter orgCode' }
  ).lean();

  if (!org) {
    throw new Error(`generateChatRef: organization ${organizationId} not found`);
  }

  const chatNumber = org.chatCounter;
  const code = (org.orgCode && org.orgCode.trim()) ? org.orgCode.trim().toUpperCase() : 'ORG';
  const chatRef = `#${code}-${chatNumber}`;

  return { chatNumber, chatRef };
}

module.exports = { generateChatRef };
