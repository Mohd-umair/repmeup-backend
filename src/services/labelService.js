const Label = require('../models/Label');
const { escapeRegex } = require('../utils/sanitize');

/**
 * Ensure default labels exist for an organization
 * Creates common labels like Lead, VIP, Important, Follow-up if they don't exist
 */
exports.ensureDefaultLabels = async (organizationId, createdBy) => {
  const defaultLabels = [
    {
      name: 'Lead',
      color: '#F59E0B', // Amber
      icon: '⭐',
      description: 'Potential customer or high-value contact'
    },
    {
      name: 'VIP',
      color: '#8B5CF6', // Purple
      icon: '👑',
      description: 'Very important person or high-priority contact'
    },
    {
      name: 'Important',
      color: '#EF4444', // Red
      icon: '❗',
      description: 'Important conversation requiring attention'
    },
    {
      name: 'Follow-up',
      color: '#3B82F6', // Blue
      icon: '🔔',
      description: 'Needs follow-up action'
    },
    {
      name: 'Resolved',
      color: '#10B981', // Green
      icon: '✅',
      description: 'Issue resolved or completed'
    }
  ];

  const createdLabels = [];

  for (const labelData of defaultLabels) {
    // Check if label already exists
    const existing = await Label.findOne({
      organization: organizationId,
      name: labelData.name
    });

    if (!existing) {
      const label = await Label.create({
        ...labelData,
        organization: organizationId,
        createdBy: createdBy,
        isSystem: false // Not system labels, can be deleted by user
      });
      createdLabels.push(label);
    }
  }

  return createdLabels;
};

/**
 * Get or create "Lead" label for an organization
 */
exports.getOrCreateLeadLabel = async (organizationId, createdBy) => {
  let leadLabel = await Label.findOne({
    organization: organizationId,
    name: 'Lead'
  });

  if (!leadLabel) {
    leadLabel = await Label.create({
      name: 'Lead',
      color: '#F59E0B', // Amber
      icon: '⭐',
      description: 'Potential customer or high-value contact',
      organization: organizationId,
      createdBy: createdBy,
      isSystem: false
    });
  }

  return leadLabel;
};

/**
 * Get label by name for an organization
 */
exports.getLabelByName = async (organizationId, name) => {
  const escaped = escapeRegex(String(name || '').trim());
  return await Label.findOne({
    organization: organizationId,
    name: { $regex: new RegExp(`^${escaped}$`, 'i') } // Case-insensitive
  });
};
