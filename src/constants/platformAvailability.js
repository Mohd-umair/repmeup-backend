/** Platforms not yet available for new connections. */
const COMING_SOON_PLATFORM_IDS = ['google', 'linkedin'];

const COMING_SOON_PLATFORM_MESSAGE =
  'This integration is coming soon and is not available yet.';

function isComingSoonPlatform(platformId) {
  if (!platformId) return false;
  return COMING_SOON_PLATFORM_IDS.includes(String(platformId).toLowerCase());
}

module.exports = {
  COMING_SOON_PLATFORM_IDS,
  COMING_SOON_PLATFORM_MESSAGE,
  isComingSoonPlatform
};
