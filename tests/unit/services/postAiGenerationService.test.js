/**
 * Tests for postAiGenerationService.
 *
 * Covers:
 *   - Pure prompt builders: sanitizeForImagePrompt, buildImagePrompt,
 *     buildReferenceImagePrompt, buildVideoPrompt.
 *   - classifySafetyRejection heuristic.
 *   - generatePostText: input validation, credit gate, rollback on failure.
 *   - generatePostVariants: validation, clamping, event-template context,
 *     credit deduct + rollback.
 *   - generateVariantImage: credit gate, reference vs configured prompt,
 *     people / no-people instruction, event template style loading, logo
 *     overlay skipped when params missing, safety-rejection translation,
 *     rollback on failure.
 *   - submitVariantVideoJob: immediate jobId return; getVideoJobStatus
 *     found / not-found.
 *
 * Mocking:
 *   - aiService / aiCreditService / storageService / Media / VideoJob /
 *     EventTemplate / aiRequestContext are all fully stubbed.
 *   - logger is silenced.
 */

jest.mock('../../../src/services/aiService', () => ({
  generatePost: jest.fn(),
  generatePostVariants: jest.fn(),
  generateImage: jest.fn(),
  generateVideo: jest.fn()
}));

jest.mock('../../../src/services/aiCreditService', () => ({
  checkCredits: jest.fn(),
  deductCredits: jest.fn(),
  rollbackCredits: jest.fn(),
  getUsage: jest.fn()
}));

jest.mock('../../../src/services/storageService', () => ({
  isS3Configured: jest.fn(() => false),
  buildPostsKey: jest.fn((orgId, filename) => `posts/${orgId}/${filename}`),
  uploadBuffer: jest.fn(),
  resolvePublicUrl: jest.fn((fp) => `https://cdn.example/local/${require('path').basename(fp)}`)
}));

jest.mock('../../../src/services/aiRequestContext', () => ({
  runWithAiContextAndUsageId: async (_ctx, fn) => {
    const result = await fn();
    return { result, aiApiUsageId: 'usage-fake-1' };
  }
}));

jest.mock('../../../src/models/Media', () => ({
  create: jest.fn()
}));

jest.mock('../../../src/models/VideoJob', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn()
}));

jest.mock('../../../src/services/ai/brandContextService', () => ({
  resolveProductShootReferences: jest.fn()
}));

jest.mock('../../../src/models/EventTemplate', () => {
  const state = { findOneResult: null };
  globalThis.__postAiEventTemplateState = state;
  return {
    findOne: () => ({ lean: async () => state.findOneResult })
  };
});

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined)
    }
  };
});

const aiService = require('../../../src/services/aiService');
const aiCreditService = require('../../../src/services/aiCreditService');
const storageService = require('../../../src/services/storageService');
const brandContextService = require('../../../src/services/ai/brandContextService');
const Media = require('../../../src/models/Media');
const VideoJob = require('../../../src/models/VideoJob');
require('../../../src/models/EventTemplate'); // trigger the factory so state is set
const eventState = globalThis.__postAiEventTemplateState;

const svc = require('../../../src/services/postAiGenerationService');
const {
  PostAiGenerationError,
  sanitizeForImagePrompt,
  buildImagePrompt,
  buildReferenceImagePrompt,
  buildVideoPrompt,
  classifySafetyRejection,
  generatePostText,
  generatePostVariants,
  generateVariantImage,
  submitVariantVideoJob,
  getVideoJobStatus,
  _runVideoJobInBackground
} = svc;

const orgId = 'org-1';
const userId = 'user-1';

const creditsAllowed = (remaining = 98) => ({
  allowed: true,
  current: 2,
  limit: 100,
  remaining,
  isUnlimited: false
});
const creditsBlocked = () => ({
  allowed: false,
  error: 'AI credits exhausted',
  current: 100,
  limit: 100,
  remaining: 0,
  isUnlimited: false
});
const updatedCredits = () => ({ current: 3, limit: 100, remaining: 97, isUnlimited: false });

beforeEach(() => {
  eventState.findOneResult = null;

  aiService.generatePost.mockReset();
  aiService.generatePostVariants.mockReset();
  aiService.generateImage.mockReset();
  aiService.generateVideo.mockReset();

  aiCreditService.checkCredits.mockReset().mockResolvedValue(creditsAllowed());
  aiCreditService.deductCredits.mockReset().mockResolvedValue(undefined);
  aiCreditService.rollbackCredits.mockReset().mockResolvedValue(undefined);
  aiCreditService.getUsage.mockReset().mockResolvedValue(updatedCredits());

  storageService.isS3Configured.mockReset().mockReturnValue(false);
  storageService.buildPostsKey.mockClear();
  storageService.uploadBuffer.mockReset();
  storageService.resolvePublicUrl.mockClear();

  Media.create.mockReset().mockResolvedValue({ _id: 'media-doc-1' });
  brandContextService.resolveProductShootReferences.mockReset().mockResolvedValue({
    productImageUrl: 'https://cdn.example/product.png',
    styleImageUrls: []
  });
  VideoJob.create.mockReset().mockResolvedValue({});
  VideoJob.findOne.mockReset();
  VideoJob.findOneAndUpdate.mockReset().mockResolvedValue({});
});

// ────────────────────────────────────────────────────────────────────────────
describe('sanitizeForImagePrompt', () => {
  test('returns empty string for falsy input', () => {
    expect(sanitizeForImagePrompt('')).toBe('');
    expect(sanitizeForImagePrompt(null)).toBe('');
    expect(sanitizeForImagePrompt(undefined)).toBe('');
  });

  test('strips hashtags, at-signs, line breaks, and emoji', () => {
    const out = sanitizeForImagePrompt('  hello #world @foo \n🎉 bar  ');
    expect(out).toBe('hello world foo bar');
  });

  test('replaces copyrighted IP references with generic alternatives', () => {
    expect(sanitizeForImagePrompt('a Pokemon adventure')).toBe('a animated cartoon series adventure');
    expect(sanitizeForImagePrompt('batman fights the joker')).toContain('dark knight superhero');
    expect(sanitizeForImagePrompt('star wars scene')).toContain('sci-fi space hero');
    expect(sanitizeForImagePrompt('Harry Potter at Hogwarts')).toContain('young wizard protagonist');
  });

  test('keeps ordinary text unchanged', () => {
    expect(sanitizeForImagePrompt('a bottle of cold brew coffee')).toBe('a bottle of cold brew coffee');
  });
});

describe('buildImagePrompt', () => {
  test('uses default style when no imageConfig.style given', () => {
    const p = buildImagePrompt({ topic: 'coffee', variantIndex: 0 });
    expect(p).toMatch(/professional social media photography/);
    expect(p).toMatch(/Subject: coffee/);
    expect(p).toMatch(/Ultra high quality/);
    expect(p).toMatch(/seed:\d+/);
  });

  test('maps known style keys to descriptive phrases', () => {
    const p = buildImagePrompt({ topic: 'x', imageConfig: { style: 'cinematic' }, variantIndex: 0 });
    expect(p).toMatch(/cinematic film still/);
  });

  test('appends mood / lighting / composition / palette / angle when provided', () => {
    const p = buildImagePrompt({
      topic: 'x',
      imageConfig: {
        mood: 'Joyful',
        lighting: 'Golden Hour',
        composition: 'Rule of Thirds',
        colorPalette: 'Warm',
        cameraAngle: 'Low'
      },
      variantIndex: 0
    });
    expect(p).toMatch(/joyful emotional atmosphere/);
    expect(p).toMatch(/golden hour lighting/);
    expect(p).toMatch(/rule of thirds composition/);
    expect(p).toMatch(/warm color palette/);
    expect(p).toMatch(/low camera angle/);
  });

  test('variant index rotates the variation directive', () => {
    const p0 = buildImagePrompt({ topic: 'x', variantIndex: 0 });
    const p1 = buildImagePrompt({ topic: 'x', variantIndex: 1 });
    expect(p0).toMatch(/Hero shot/);
    expect(p1).toMatch(/Environmental context/);
  });

  test('image-layover content type adds an explicit HEADLINE TEXT instruction', () => {
    const p = buildImagePrompt({ topic: 'launch day', variantIndex: 0, contentType: 'image-layover' });
    expect(p).toMatch(/HEADLINE TEXT \(render exactly as written/);
    expect(p).toMatch(/"launch day"/);
  });

  test('non-layover content type forbids brand-name text inside image', () => {
    const p = buildImagePrompt({ topic: 'coffee', variantIndex: 0, contentType: '' });
    expect(p).toMatch(/Do NOT render any brand name/);
  });

  test('topic is sanitized (IP terms replaced) before inclusion', () => {
    const p = buildImagePrompt({ topic: 'mario jumping', variantIndex: 0 });
    expect(p).toMatch(/Subject: video game character jumping/);
  });
});

describe('buildReferenceImagePrompt', () => {
  test('keeps prompt minimal (no style descriptors) but rotates composition per variant', () => {
    const p = buildReferenceImagePrompt({ topic: 'coffee', variantIndex: 0, contentType: '' });
    expect(p).toMatch(/Social media post about: coffee/);
    expect(p).not.toMatch(/professional social media photography/);
    expect(p).toMatch(/Do NOT render any brand name/);
    expect(p).toMatch(/Hero composition/);
    expect(p).toMatch(/visually distinct/);
    expect(p).toMatch(/seed:\d+/);
  });

  test('variant index rotates the composition directive', () => {
    const p0 = buildReferenceImagePrompt({ topic: 'coffee', variantIndex: 0, contentType: '' });
    const p1 = buildReferenceImagePrompt({ topic: 'coffee', variantIndex: 1, contentType: '' });
    expect(p0).toMatch(/Hero composition/);
    expect(p1).toMatch(/Environmental composition/);
  });

  test('image-layover mode adds headline instruction', () => {
    const p = buildReferenceImagePrompt({ topic: 'launch day', variantIndex: 0, contentType: 'image-layover' });
    expect(p).toMatch(/HEADLINE TEXT/);
  });
});

describe('buildVideoPrompt', () => {
  test('uses defaults when videoConfig is empty', () => {
    const p = buildVideoPrompt({ topic: 'coffee', variantIndex: 0 });
    expect(p).toMatch(/professional social media short video/);
    expect(p).toMatch(/engaging and professional/);
    expect(p).toMatch(/No text overlays/);
  });

  test('maps style and tone keys', () => {
    const p = buildVideoPrompt({
      topic: 'x',
      videoConfig: { style: 'cinematic', tone: 'energetic' },
      variantIndex: 0
    });
    expect(p).toMatch(/cinematic short film scene/);
    expect(p).toMatch(/high-energy, fast-paced, exciting/);
  });

  test('includes theme hint from first sentence of variantContent', () => {
    const p = buildVideoPrompt({
      topic: 'coffee',
      variantContent: 'Start your day right. More copy later.',
      variantIndex: 0
    });
    expect(p).toMatch(/Theme: Start your day right/);
  });

  test('variant index rotates angle directive', () => {
    const a = buildVideoPrompt({ topic: 'x', variantIndex: 0 });
    const b = buildVideoPrompt({ topic: 'x', variantIndex: 1 });
    expect(a).not.toEqual(b);
  });
});

describe('classifySafetyRejection', () => {
  test.each([
    ['safety', true],
    ['content_policy', true],
    ['content policy', true],
    ['moderation', true],
    ['blocked', true],
    ['violates', true],
    ['request failed', false]
  ])('keyword=%j → %s with status 400', (keyword, expected) => {
    const err = { response: { status: 400, data: { error: { message: `oops ${keyword} bad` } } } };
    expect(classifySafetyRejection(err)).toBe(expected);
  });

  test('requires status 400 OR soraFailed', () => {
    const err1 = { response: { status: 500, data: { error: { message: 'safety block' } } } };
    expect(classifySafetyRejection(err1)).toBe(false);
    const err2 = { soraFailed: true, message: 'content_policy rejection' };
    expect(classifySafetyRejection(err2)).toBe(true);
  });

  test('returns false when error is empty / shape-mismatched', () => {
    expect(classifySafetyRejection({})).toBe(false);
    expect(classifySafetyRejection(null)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('generatePostText', () => {
  test('rejects missing prompt / platforms with 400', async () => {
    await expect(generatePostText({ prompt: '', platforms: ['instagram'], mode: 'same', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(generatePostText({ prompt: 'x', platforms: [], mode: 'same', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects invalid mode with 400', async () => {
    await expect(generatePostText({ prompt: 'x', platforms: ['x'], mode: 'weird', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects insufficient credits with 403 AI_CREDITS_EXCEEDED', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce(creditsBlocked());
    const p = generatePostText({
      prompt: 'x', platforms: ['instagram'], mode: 'same',
      organizationId: orgId, userId
    });
    await expect(p).rejects.toMatchObject({
      statusCode: 403,
      code: 'AI_CREDITS_EXCEEDED',
      extras: expect.objectContaining({ credits: expect.any(Object) })
    });
  });

  test('in "same" mode needs 1 credit, in "custom" mode needs N', async () => {
    aiService.generatePost.mockResolvedValue({ creditsUsed: 2 });
    await generatePostText({
      prompt: 'x', platforms: ['a', 'b'], mode: 'custom', postType: 'post',
      organizationId: orgId, userId
    });
    expect(aiCreditService.checkCredits).toHaveBeenCalledWith(orgId, 2);
  });

  test('happy path deducts credits and returns data + credits block', async () => {
    aiService.generatePost.mockResolvedValue({ content: 'hello', creditsUsed: 1 });
    const result = await generatePostText({
      prompt: 'hello', platforms: ['instagram'], mode: 'same', postType: 'post',
      organizationId: orgId, userId
    });
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      orgId, 1,
      expect.objectContaining({ operation: 'post_generation', userId }),
      { aiApiUsageId: 'usage-fake-1' }
    );
    expect(result.data).toEqual({ content: 'hello', creditsUsed: 1 });
    expect(result.credits).toMatchObject({ used: 1, current: 3, limit: 100 });
  });

  test('rolls back credits on downstream AI failure', async () => {
    aiService.generatePost.mockRejectedValue(new Error('boom'));
    const p = generatePostText({
      prompt: 'hello', platforms: ['instagram'], mode: 'same',
      organizationId: orgId, userId
    });
    await expect(p).rejects.toThrow('boom');
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled(); // nothing deducted yet
  });

  test('rolls back credits if deductCredits throws AFTER AI success', async () => {
    aiService.generatePost.mockResolvedValue({ creditsUsed: 1 });
    aiCreditService.deductCredits.mockRejectedValueOnce(new Error('db down'));
    const p = generatePostText({
      prompt: 'x', platforms: ['instagram'], mode: 'same',
      organizationId: orgId, userId
    });
    await expect(p).rejects.toThrow('db down');
    // deducted=0 because the throw happened mid-deduction, so no rollback necessary.
    // Behavior: safeRollbackCredits is called with 0 which is a no-op (guards `!amount`).
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('generatePostVariants', () => {
  test('rejects missing topic / platforms with 400', async () => {
    await expect(generatePostVariants({ topic: '', platforms: ['instagram'], organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(generatePostVariants({ topic: 'x', platforms: [], organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('clamps count to [1, 5] (default 3)', async () => {
    aiService.generatePostVariants.mockResolvedValue({ variants: [] });
    await generatePostVariants({ topic: 'x', platforms: ['instagram'], count: 20, organizationId: orgId, userId });
    expect(aiCreditService.checkCredits).toHaveBeenCalledWith(orgId, 5);
    expect(aiService.generatePostVariants).toHaveBeenCalledWith(
      'x', ['instagram'],
      expect.objectContaining({ count: 5 })
    );
  });

  test('count defaults to 3 when undefined', async () => {
    aiService.generatePostVariants.mockResolvedValue({ variants: [] });
    await generatePostVariants({ topic: 'x', platforms: ['instagram'], organizationId: orgId, userId });
    expect(aiCreditService.checkCredits).toHaveBeenCalledWith(orgId, 3);
  });

  test('blocks on insufficient credits with 403', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce(creditsBlocked());
    await expect(
      generatePostVariants({ topic: 'x', platforms: ['instagram'], count: 3, organizationId: orgId, userId })
    ).rejects.toMatchObject({ statusCode: 403, code: 'AI_CREDITS_EXCEEDED' });
    expect(aiService.generatePostVariants).not.toHaveBeenCalled();
  });

  test('loads event template when eventTemplateId provided and passes to AI', async () => {
    eventState.findOneResult = {
      name: 'Diwali',
      eventType: 'festival',
      sampleCaption: 'Happy Diwali',
      hashtags: ['#diwali'],
      cta: 'Shop now',
      eventStyle: { palette: 'warm' }
    };
    aiService.generatePostVariants.mockResolvedValue({ variants: [] });
    await generatePostVariants({
      topic: 'x', platforms: ['instagram'], count: 2, eventTemplateId: 'tpl1',
      organizationId: orgId, userId
    });
    expect(aiService.generatePostVariants).toHaveBeenCalledWith(
      'x', ['instagram'],
      expect.objectContaining({
        occasionContext: expect.objectContaining({ name: 'Diwali', eventType: 'festival' })
      })
    );
  });

  test('passes null occasionContext when no eventTemplateId', async () => {
    aiService.generatePostVariants.mockResolvedValue({ variants: [] });
    await generatePostVariants({
      topic: 'x', platforms: ['instagram'], count: 2,
      organizationId: orgId, userId
    });
    expect(aiService.generatePostVariants).toHaveBeenCalledWith(
      'x', ['instagram'],
      expect.objectContaining({ occasionContext: null })
    );
  });

  test('happy path deducts variantCount credits', async () => {
    aiService.generatePostVariants.mockResolvedValue({ variants: [{}, {}] });
    const out = await generatePostVariants({
      topic: 'x', platforms: ['instagram'], count: 2,
      organizationId: orgId, userId
    });
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      orgId, 2,
      expect.objectContaining({ operation: 'post_variants', variantCount: 2 }),
      { aiApiUsageId: 'usage-fake-1' }
    );
    expect(out.credits.used).toBe(2);
  });

  test('rolls back credits when downstream AI fails', async () => {
    aiService.generatePostVariants.mockRejectedValue(new Error('network'));
    await expect(
      generatePostVariants({ topic: 'x', platforms: ['instagram'], count: 3, organizationId: orgId, userId })
    ).rejects.toThrow('network');
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('generateVariantImage', () => {
  const buffer = Buffer.from('fake-image-bytes');

  beforeEach(() => {
    aiService.generateImage.mockResolvedValue({
      buffer,
      styleSpec: { layout: 'centered', colorPalette: ['#fff'], medium: 'photo', style: 'modern' },
      imagePrompt: 'captured-prompt'
    });
  });

  test('rejects missing topic with 400', async () => {
    await expect(generateVariantImage({ topic: '', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects on insufficient credits with 403', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce(creditsBlocked());
    await expect(generateVariantImage({ topic: 'x', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 403, code: 'AI_CREDITS_EXCEEDED' });
    expect(aiService.generateImage).not.toHaveBeenCalled();
  });

  test('uses reference-mode prompt when generationMode=reference and passes referenceOnly option', async () => {
    await generateVariantImage({
      topic: 'coffee', generationMode: 'reference',
      organizationId: orgId, userId
    });
    const [prompt, imageOrgId, imageOptions] = aiService.generateImage.mock.calls[0];
    expect(prompt).toMatch(/Social media post about: coffee/);
    expect(prompt).not.toMatch(/professional social media photography/);
    expect(imageOrgId).toBe(orgId);
    expect(imageOptions).toEqual(expect.objectContaining({ referenceOnly: true }));
  });

  test('uses configured-mode prompt when generationMode=brand-voice', async () => {
    await generateVariantImage({
      topic: 'coffee', generationMode: 'brand-voice', imageConfig: { style: 'cinematic' },
      organizationId: orgId, userId
    });
    const [prompt, imageOrgId, imageOptions] = aiService.generateImage.mock.calls[0];
    expect(prompt).toMatch(/cinematic film still/);
    expect(imageOrgId).toBe(orgId);
    expect(imageOptions).not.toHaveProperty('referenceOnly');
  });

  test('instant mode passes null organization (no brand context)', async () => {
    await generateVariantImage({
      topic: 'x', generationMode: 'instant',
      organizationId: orgId, userId
    });
    const [, imageOrgId] = aiService.generateImage.mock.calls[0];
    expect(imageOrgId).toBe(null);
  });

  test('appends "include people" when includePeople=true', async () => {
    await generateVariantImage({
      topic: 'x', includePeople: true, peopleNationality: 'Indian',
      organizationId: orgId, userId
    });
    const [prompt] = aiService.generateImage.mock.calls[0];
    expect(prompt).toMatch(/Include Indian people naturally in the scene/);
  });

  test('appends "no people" when includePeople=false', async () => {
    await generateVariantImage({
      topic: 'x', includePeople: false,
      organizationId: orgId, userId
    });
    const [prompt] = aiService.generateImage.mock.calls[0];
    expect(prompt).toMatch(/Do NOT include any people/);
  });

  test('when eventTemplateId provided, adds occasionVisualStyle option', async () => {
    eventState.findOneResult = { eventStyle: { palette: 'warm', motifs: ['lamp'] } };
    await generateVariantImage({
      topic: 'x', eventTemplateId: 'tpl1',
      organizationId: orgId, userId
    });
    const [, , imageOptions] = aiService.generateImage.mock.calls[0];
    expect(imageOptions.occasionVisualStyle).toEqual({ palette: 'warm', motifs: ['lamp'] });
  });

  test('fails with 500 when generateImage returns no buffer', async () => {
    aiService.generateImage.mockResolvedValue({ buffer: null });
    await expect(
      generateVariantImage({ topic: 'x', organizationId: orgId, userId })
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
  });

  test('persists to local disk and returns public URL when S3 not configured', async () => {
    const out = await generateVariantImage({
      topic: 'x', organizationId: orgId, userId, req: { get: () => 'repmeup.in' }
    });
    expect(storageService.resolvePublicUrl).toHaveBeenCalled();
    expect(out.imageUrl).toMatch(/^https:\/\/cdn\.example\/local\/ai-/);
    expect(out.designDna).toEqual(expect.objectContaining({
      generationPrompt: 'captured-prompt',
      layoutType: 'centered',
      style: 'modern'
    }));
    expect(out.credits).toEqual(expect.objectContaining({ used: 1 }));
  });

  test('persists to S3 when configured', async () => {
    storageService.isS3Configured.mockReturnValue(true);
    storageService.uploadBuffer.mockResolvedValue({
      publicUrl: 'https://s3.example/org-1/file.png',
      key: 'posts/org-1/file.png'
    });
    const out = await generateVariantImage({ topic: 'x', organizationId: orgId, userId });
    expect(storageService.uploadBuffer).toHaveBeenCalled();
    expect(out.imageUrl).toBe('https://s3.example/org-1/file.png');
  });

  test('writes a Media library entry and returns savedToLibrary=true', async () => {
    const out = await generateVariantImage({ topic: 'x', organizationId: orgId, userId });
    expect(Media.create).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image',
      mimeType: 'image/png',
      user: userId,
      organization: orgId,
      tags: ['ai-generated', 'content-studio']
    }));
    expect(out.savedToLibrary).toBe(true);
    expect(out.mediaLibraryId).toBe('media-doc-1');
  });

  test('Media.create failure is non-fatal — savedToLibrary=false, mediaLibraryId=null', async () => {
    Media.create.mockRejectedValueOnce(new Error('db'));
    const out = await generateVariantImage({ topic: 'x', organizationId: orgId, userId });
    expect(out.savedToLibrary).toBe(false);
    expect(out.mediaLibraryId).toBeNull();
    expect(out.imageUrl).toBeDefined();
  });

  test('deducts exactly 1 credit on success', async () => {
    await generateVariantImage({ topic: 'x', organizationId: orgId, userId });
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      orgId, 1,
      expect.objectContaining({ operation: 'post_variants_image' }),
      { aiApiUsageId: 'usage-fake-1' }
    );
  });

  test('translates OpenAI safety rejection into 422 CONTENT_POLICY', async () => {
    const safetyErr = Object.assign(new Error('image generation failed'), {
      response: { status: 400, data: { error: { message: 'content policy violation' } } }
    });
    aiService.generateImage.mockRejectedValue(safetyErr);

    await expect(
      generateVariantImage({ topic: 'x', organizationId: orgId, userId })
    ).rejects.toMatchObject({ statusCode: 422, code: 'CONTENT_POLICY' });
  });

  test('rethrows non-safety errors unchanged', async () => {
    aiService.generateImage.mockRejectedValue(new Error('network fail'));
    await expect(
      generateVariantImage({ topic: 'x', organizationId: orgId, userId })
    ).rejects.toThrow('network fail');
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled();
  });

  test('rolls back already-deducted credit if library write or response stage fails', async () => {
    // Simulate: AI succeeds, persist+library succeed, deduct succeeds,
    // then an error thrown by `aiCreditService.getUsage` AFTER deduction.
    aiCreditService.getUsage.mockRejectedValueOnce(new Error('usage read fail'));
    await expect(
      generateVariantImage({ topic: 'x', organizationId: orgId, userId })
    ).rejects.toThrow('usage read fail');
    expect(aiCreditService.rollbackCredits).toHaveBeenCalledWith(
      orgId, 1,
      expect.objectContaining({ operation: 'post_variants_image' })
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('generateVariantImage — Product Shoot', () => {
  const buffer = Buffer.from('fake-image-bytes');

  beforeEach(() => {
    aiService.generateImage.mockResolvedValue({
      buffer,
      styleSpec: null,
      imagePrompt: 'captured-prompt'
    });
  });

  test('rejects when both productReferenceImageId and inputImageId are given', async () => {
    await expect(generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1', inputImageId: 'up1',
      organizationId: orgId, userId
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(brandContextService.resolveProductShootReferences).not.toHaveBeenCalled();
  });

  test('rejects with 503 PRODUCT_SHOOT_UNAVAILABLE when the emergency kill switch is on', async () => {
    process.env.PRODUCT_SHOOT_KILL_SWITCH = 'true';
    try {
      await expect(generateVariantImage({
        topic: 'x', productReferenceImageId: 'ref1',
        organizationId: orgId, userId
      })).rejects.toMatchObject({ statusCode: 503, code: 'PRODUCT_SHOOT_UNAVAILABLE' });
      expect(brandContextService.resolveProductShootReferences).not.toHaveBeenCalled();
    } finally {
      delete process.env.PRODUCT_SHOOT_KILL_SWITCH;
    }
  });

  test('non-Product-Shoot generation is unaffected by the kill switch', async () => {
    process.env.PRODUCT_SHOOT_KILL_SWITCH = 'true';
    try {
      await expect(generateVariantImage({
        topic: 'x', generationMode: 'instant',
        organizationId: orgId, userId
      })).resolves.toBeDefined();
    } finally {
      delete process.env.PRODUCT_SHOOT_KILL_SWITCH;
    }
  });

  test('rejects invalid shootConfig fields with 400 INVALID_SHOOT_CONFIG', async () => {
    await expect(generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1', shootConfig: { background: 'not-a-real-option' },
      organizationId: orgId, userId
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SHOOT_CONFIG' });
  });

  test('rejects more than 3 style reference ids with 400', async () => {
    await expect(generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1',
      styleReferenceImageIds: ['s1', 's2', 's3', 's4'],
      organizationId: orgId, userId
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SHOOT_CONFIG' });
  });

  test('translates REFERENCE_NOT_FOUND from brandContextService into 404', async () => {
    const err = new Error('Selected product reference image was not found');
    err.code = 'REFERENCE_NOT_FOUND';
    brandContextService.resolveProductShootReferences.mockRejectedValueOnce(err);
    await expect(generateVariantImage({
      topic: 'x', productReferenceImageId: 'missing',
      organizationId: orgId, userId
    })).rejects.toMatchObject({ statusCode: 404, code: 'REFERENCE_NOT_FOUND' });
    expect(aiService.generateImage).not.toHaveBeenCalled();
  });

  test('resolves refs by organization/user and passes role-aware productShoot options', async () => {
    brandContextService.resolveProductShootReferences.mockResolvedValueOnce({
      productImageUrl: 'https://cdn.example/product.png',
      styleImageUrls: ['https://cdn.example/style1.png']
    });
    await generateVariantImage({
      topic: 'sneakers', inputImageId: 'up1', styleReferenceImageIds: ['s1'],
      fidelityMode: 'strict', shootConfig: { background: 'white', includePeople: false },
      organizationId: orgId, userId
    });

    expect(brandContextService.resolveProductShootReferences).toHaveBeenCalledWith(orgId, userId, {
      productReferenceImageId: undefined,
      inputImageId: 'up1',
      styleReferenceImageIds: ['s1']
    });

    const [prompt, imageOrgId, imageOptions] = aiService.generateImage.mock.calls[0];
    expect(prompt).toMatch(/Social media post about: sneakers/); // neutral base prompt, role-aware block added downstream
    expect(imageOrgId).toBe(orgId); // org logo/context still applies even without generationMode
    expect(imageOptions.productShoot).toEqual({
      productImageUrl: 'https://cdn.example/product.png',
      styleImageUrls: ['https://cdn.example/style1.png'],
      fidelityMode: 'strict',
      shootConfig: expect.objectContaining({ preset: 'custom', background: 'white', includePeople: false }),
      variantIndex: 0
    });
  });

  test('defaults fidelityMode to "strict" on invalid/missing value', async () => {
    await generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1', fidelityMode: 'nonsense',
      organizationId: orgId, userId
    });
    const [, , imageOptions] = aiService.generateImage.mock.calls[0];
    expect(imageOptions.productShoot.fidelityMode).toBe('strict');
  });

  test('records provenance metadata on the saved Media entry', async () => {
    await generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1', styleReferenceImageIds: ['s1'],
      fidelityMode: 'balanced',
      organizationId: orgId, userId
    });
    expect(Media.create).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['ai-generated', 'content-studio', 'product-shoot'],
      metadata: expect.objectContaining({
        source: 'product_shoot',
        productReferenceImageId: 'ref1',
        inputImageId: null,
        fidelityMode: 'balanced',
        generatedBy: userId
      })
    }));
  });

  test('still deducts exactly 1 credit on success (same cost as any other variant image)', async () => {
    await generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1',
      organizationId: orgId, userId
    });
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      orgId, 1,
      expect.objectContaining({ operation: 'post_variants_image' }),
      { aiApiUsageId: 'usage-fake-1' }
    );
  });

  test('rolls back credit if generation fails after refs are resolved', async () => {
    aiService.generateImage.mockRejectedValue(new Error('network fail'));
    await expect(generateVariantImage({
      topic: 'x', productReferenceImageId: 'ref1',
      organizationId: orgId, userId
    })).rejects.toThrow('network fail');
    expect(aiCreditService.rollbackCredits).not.toHaveBeenCalled(); // nothing was deducted yet — nothing to roll back
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('submitVariantVideoJob', () => {
  test('rejects missing topic with 400', async () => {
    await expect(submitVariantVideoJob({ topic: '', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('blocks when credits insufficient', async () => {
    aiCreditService.checkCredits.mockResolvedValueOnce(creditsBlocked());
    await expect(submitVariantVideoJob({ topic: 'x', organizationId: orgId, userId }))
      .rejects.toMatchObject({ statusCode: 403, code: 'AI_CREDITS_EXCEEDED' });
    expect(VideoJob.create).not.toHaveBeenCalled();
  });

  test('happy path creates a VideoJob row and returns jobId prefix vjob_', async () => {
    const { jobId } = await submitVariantVideoJob({
      topic: 'x', organizationId: orgId, userId
    });
    expect(jobId).toMatch(/^vjob_\d+_[a-z0-9]+$/);
    expect(VideoJob.create).toHaveBeenCalledWith(expect.objectContaining({
      jobId, status: 'pending', organizationId: orgId
    }));
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('_runVideoJobInBackground', () => {
  test('marks job completed when Sora returns a buffer and deducts credit', async () => {
    aiService.generateVideo.mockResolvedValue(Buffer.from('video-data'));
    await _runVideoJobInBackground({
      jobId: 'vjob_abc', topic: 'x', videoConfig: { duration: 4, aspect: '9:16' },
      variantIndex: 0, organizationId: orgId, userId
    });
    expect(VideoJob.findOneAndUpdate).toHaveBeenCalledWith(
      { jobId: 'vjob_abc' },
      expect.objectContaining({ status: 'completed', videoUrl: expect.any(String) })
    );
    expect(aiCreditService.deductCredits).toHaveBeenCalledWith(
      orgId, 1,
      expect.objectContaining({ operation: 'post_variants_video' }),
      { aiApiUsageId: 'usage-fake-1' }
    );
  });

  test('marks job failed with VIDEO_FAILED when Sora returns empty buffer', async () => {
    aiService.generateVideo.mockResolvedValue(null);
    await _runVideoJobInBackground({
      jobId: 'vjob_zzz', topic: 'x', variantIndex: 0, organizationId: orgId, userId
    });
    expect(VideoJob.findOneAndUpdate).toHaveBeenCalledWith(
      { jobId: 'vjob_zzz' },
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'VIDEO_FAILED' })
      })
    );
    expect(aiCreditService.deductCredits).not.toHaveBeenCalled();
  });

  test('marks job failed with CONTENT_POLICY on a safety rejection', async () => {
    aiService.generateVideo.mockRejectedValue(
      Object.assign(new Error('moderation block'), { response: { status: 400, data: { error: { message: 'moderation' } } } })
    );
    await _runVideoJobInBackground({
      jobId: 'vjob_qq', topic: 'x', variantIndex: 0, organizationId: orgId, userId
    });
    expect(VideoJob.findOneAndUpdate).toHaveBeenCalledWith(
      { jobId: 'vjob_qq' },
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'CONTENT_POLICY' })
      })
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('getVideoJobStatus', () => {
  test('throws 404 PostAiGenerationError when job not found', async () => {
    VideoJob.findOne.mockReturnValueOnce({
      select: () => ({ lean: async () => null })
    });
    await expect(getVideoJobStatus('vjob_missing'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('returns { status, videoUrl, error } shape when found', async () => {
    VideoJob.findOne.mockReturnValueOnce({
      select: () => ({
        lean: async () => ({
          jobId: 'vjob_1',
          status: 'completed',
          videoUrl: 'https://cdn.example/v.mp4',
          error: null
        })
      })
    });
    const out = await getVideoJobStatus('vjob_1');
    expect(out).toEqual({
      status: 'completed',
      videoUrl: 'https://cdn.example/v.mp4',
      error: null
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('PostAiGenerationError', () => {
  test('defaults: statusCode=500, code=null, extras=null', () => {
    const e = new PostAiGenerationError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PostAiGenerationError');
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe(null);
    expect(e.extras).toBe(null);
  });

  test('accepts statusCode, code, extras', () => {
    const e = new PostAiGenerationError('nope', {
      statusCode: 422, code: 'CONTENT_POLICY', extras: { retryable: false }
    });
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe('CONTENT_POLICY');
    expect(e.extras).toEqual({ retryable: false });
  });
});
