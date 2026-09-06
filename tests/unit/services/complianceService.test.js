/**
 * Tests for complianceService: the single source of truth for riskScore /
 * complianceFlags / hardViolation. Every publish/schedule/approval boundary
 * must recompute through here — client-supplied values are never trusted
 * (see postController.sendToApproval, publishPost, schedulePost).
 */
jest.mock('../../../src/models/BrandConfig', () => ({ findOne: jest.fn() }));

const BrandConfig = require('../../../src/models/BrandConfig');
const { checkContent, assertCompliant, ComplianceError } = require('../../../src/services/complianceService');

function mockConfig(config) {
  BrandConfig.findOne.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(config)
  });
}

beforeEach(() => {
  BrandConfig.findOne.mockReset();
});

describe('checkContent', () => {
  test('non-string / empty content short-circuits to zero risk, no DB call', async () => {
    expect(await checkContent('org-1', '')).toEqual({ riskScore: 0, complianceFlags: [], hardViolation: false });
    expect(await checkContent('org-1', null)).toEqual({ riskScore: 0, complianceFlags: [], hardViolation: false });
    expect(BrandConfig.findOne).not.toHaveBeenCalled();
  });

  test('no BrandConfig for org → zero risk', async () => {
    mockConfig(null);
    const result = await checkContent('org-1', 'hello world');
    expect(result).toEqual({ riskScore: 0, complianceFlags: [], hardViolation: false });
  });

  test('banned word match → hard violation, riskScore +25 per word, flagged', async () => {
    mockConfig({ bannedWords: ['guarantee', 'cure'], legalDisclaimers: '' });
    const result = await checkContent('org-1', 'We guarantee results and offer a cure.');
    expect(result.hardViolation).toBe(true);
    expect(result.riskScore).toBe(50);
    expect(result.complianceFlags).toEqual([
      'Contains banned word: "guarantee"',
      'Contains banned word: "cure"'
    ]);
  });

  test('riskScore from banned words is capped at 100', async () => {
    mockConfig({
      bannedWords: ['a', 'b', 'c', 'd', 'e'], // 5 * 25 = 125 → capped
      legalDisclaimers: ''
    });
    const result = await checkContent('org-1', 'a b c d e all present');
    expect(result.riskScore).toBe(100);
    expect(result.hardViolation).toBe(true);
  });

  test('missing legal disclaimer → soft flag only, no hard violation', async () => {
    mockConfig({ bannedWords: [], legalDisclaimers: 'Results may vary. Terms and conditions apply to all offers.' });
    const result = await checkContent('org-1', 'Buy our product today!');
    expect(result.hardViolation).toBe(false);
    expect(result.riskScore).toBe(15);
    expect(result.complianceFlags).toEqual(['Legal disclaimer may be required']);
  });

  test('disclaimer present in content → no flag raised', async () => {
    const disclaimer = 'Results may vary. Terms and conditions apply to all offers made here.';
    mockConfig({ bannedWords: [], legalDisclaimers: disclaimer });
    const content = `Buy now! ${disclaimer}`;
    const result = await checkContent('org-1', content);
    expect(result.complianceFlags).toEqual([]);
    expect(result.riskScore).toBe(0);
  });

  test('clean content with configured rules → zero risk, no flags', async () => {
    mockConfig({ bannedWords: ['guarantee'], legalDisclaimers: '' });
    const result = await checkContent('org-1', 'Check out our new collection!');
    expect(result).toEqual({ riskScore: 0, complianceFlags: [], hardViolation: false });
  });

  test('DB error is swallowed — resolves to zero risk instead of throwing', async () => {
    BrandConfig.findOne.mockImplementation(() => { throw new Error('DB down'); });
    const result = await checkContent('org-1', 'anything');
    expect(result).toEqual({ riskScore: 0, complianceFlags: [], hardViolation: false });
  });

  test('is case-insensitive when matching banned words', async () => {
    mockConfig({ bannedWords: ['Guarantee'], legalDisclaimers: '' });
    const result = await checkContent('org-1', 'We GUARANTEE it.');
    expect(result.hardViolation).toBe(true);
  });
});

describe('assertCompliant', () => {
  test('resolves with the compliance result when there is no hard violation', async () => {
    mockConfig({ bannedWords: [], legalDisclaimers: '' });
    const result = await assertCompliant('org-1', 'Totally fine content.');
    expect(result.hardViolation).toBe(false);
  });

  test('throws ComplianceError (422, COMPLIANCE_BLOCKED) on a hard violation', async () => {
    mockConfig({ bannedWords: ['scam'], legalDisclaimers: '' });
    await expect(assertCompliant('org-1', 'This is not a scam!'))
      .rejects.toBeInstanceOf(ComplianceError);
    try {
      await assertCompliant('org-1', 'This is not a scam!');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('COMPLIANCE_BLOCKED');
      expect(err.complianceFlags).toEqual(['Contains banned word: "scam"']);
      expect(err.message).toMatch(/banned words/i);
    }
  });
});
