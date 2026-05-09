const {
  SYNC_AUTO_REPLY_AGE_MS,
  shouldSkipAiProcessingForSyncedInteraction,
  shouldApplyHeuristicIntentBucket,
  parseToEpochMs
} = require('../../../src/utils/syncInteractionBackfillGuard');

describe('syncInteractionBackfillGuard', () => {
  const now = Date.now();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns false when source is not sync', () => {
    const interaction = { source: 'webhook', platformCreatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000) };
    const conn = { connectedAt: new Date(now), createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000) };
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, conn)).toBe(false);
  });

  it('returns true when message is before connectedAt', () => {
    const connectedAt = new Date(now - 2 * 60 * 60 * 1000);
    const interaction = {
      source: 'sync',
      platformCreatedAt: new Date(now - 5 * 60 * 60 * 1000)
    };
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, { connectedAt, createdAt: connectedAt })).toBe(true);
  });

  it('uses createdAt when connectedAt is missing (historical vs connection row)', () => {
    const createdAt = new Date(now - 2 * 60 * 60 * 1000);
    const interaction = {
      source: 'sync',
      platformCreatedAt: new Date(now - 5 * 60 * 60 * 1000)
    };
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, { createdAt })).toBe(true);
  });

  it('returns false when message is after connectedAt and within 24h window', () => {
    const connectedAt = new Date(now - 10 * 60 * 60 * 1000);
    const interaction = {
      source: 'sync',
      platformCreatedAt: new Date(now - 2 * 60 * 60 * 1000)
    };
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, { connectedAt })).toBe(false);
  });

  it('returns true when message is older than SYNC_AUTO_REPLY_AGE_MS', () => {
    const connectedAt = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const msgDate = new Date(now - SYNC_AUTO_REPLY_AGE_MS - 60 * 1000);
    const interaction = { source: 'sync', platformCreatedAt: msgDate };
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, { connectedAt })).toBe(true);
  });

  it('returns true when msg date is invalid / missing', () => {
    expect(
      shouldSkipAiProcessingForSyncedInteraction({ source: 'sync', platformCreatedAt: null }, { connectedAt: new Date() })
    ).toBe(true);
    expect(
      shouldSkipAiProcessingForSyncedInteraction({ source: 'sync', createdAt: 'not-a-date' }, { connectedAt: new Date() })
    ).toBe(true);
  });

  it('treats source with different casing / whitespace as sync', () => {
    const msgDate = new Date(now - SYNC_AUTO_REPLY_AGE_MS - 60 * 1000);
    expect(
      shouldSkipAiProcessingForSyncedInteraction({ source: '  SYNC ', platformCreatedAt: msgDate }, { connectedAt: new Date(now) })
    ).toBe(true);
  });

  it('parses Unix seconds for platformCreatedAt', () => {
    const sec = Math.floor((now - 3 * 60 * 60 * 1000) / 1000);
    const interaction = { source: 'sync', platformCreatedAt: sec };
    const connectedAt = new Date(now - 10 * 60 * 60 * 1000);
    expect(shouldSkipAiProcessingForSyncedInteraction(interaction, { connectedAt })).toBe(false);
  });

  it('future-dated message is not treated as too-old by negative age', () => {
    const future = new Date(now + 60 * 60 * 1000);
    const connectedAt = new Date(now - 24 * 60 * 60 * 1000);
    expect(shouldSkipAiProcessingForSyncedInteraction({ source: 'sync', platformCreatedAt: future }, { connectedAt })).toBe(
      false
    );
  });

  it('historical uses numeric cutoff (connectedAt as Unix sec)', () => {
    const connectedSec = Math.floor((now - 2 * 60 * 60 * 1000) / 1000);
    const msg = new Date(now - 5 * 60 * 60 * 1000);
    expect(shouldSkipAiProcessingForSyncedInteraction({ source: 'sync', platformCreatedAt: msg }, { connectedAt: connectedSec })).toBe(
      true
    );
  });

  it('parseToEpochMs returns null for unusable input', () => {
    expect(parseToEpochMs(undefined)).toBeNull();
    expect(parseToEpochMs('')).toBeNull();
    expect(parseToEpochMs(Number.NaN)).toBeNull();
  });

  describe('shouldApplyHeuristicIntentBucket', () => {
    it('false when bucket already set', () => {
      expect(shouldApplyHeuristicIntentBucket({ intentBucket: '507f1f77bcf86cd799439011' })).toBe(false);
    });

    it('false when bucketAssignedBy is manual (even if bucket cleared)', () => {
      expect(shouldApplyHeuristicIntentBucket({ intentBucket: null, bucketAssignedBy: 'manual' })).toBe(false);
      expect(shouldApplyHeuristicIntentBucket({ bucketAssignedBy: 'MANUAL' })).toBe(false);
    });

    it('true when no bucket and not manual', () => {
      expect(shouldApplyHeuristicIntentBucket({ intentBucket: null, bucketAssignedBy: 'ai' })).toBe(true);
      expect(shouldApplyHeuristicIntentBucket({})).toBe(true);
    });
  });

  it('export SYNC_AUTO_REPLY_AGE_MS is 24 hours', () => {
    expect(SYNC_AUTO_REPLY_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
