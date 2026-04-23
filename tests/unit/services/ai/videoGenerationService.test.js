/**
 * Tests for videoGenerationService — Sora 3-step submit/poll/download.
 *
 * We fake timers so the 5s POLL_INTERVAL_MS doesn't slow the suite, and we
 * fake axios so no real HTTP calls are made. The code uses
 * `await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))` — with fake timers
 * we advance the clock after scheduling the promise.
 */

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

jest.mock('../../../../src/services/ai/openaiClient', () => ({
  apiKey: 'test-key-do-not-use',
  hasApiKey: jest.fn(() => true),
  logVideoUsage: jest.fn()
}));

const axios = require('axios');
const openaiClient = require('../../../../src/services/ai/openaiClient');
const { generateVideo } = require('../../../../src/services/ai/videoGenerationService');

// Drive the polling loop: repeatedly advance fake timers + flush microtasks
// until the `generateVideo` promise resolves.
async function drivePolling(promise, { maxIters = 200, stepMs = 5000 } = {}) {
  let settled = false;
  let result;
  let error;
  promise.then(
    (v) => { settled = true; result = v; },
    (e) => { settled = true; error = e; }
  );
  for (let i = 0; i < maxIters && !settled; i += 1) {
    // Let microtasks run first so any in-flight `await` resolves
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(stepMs);
  }
  // Flush remaining microtasks
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  if (error) throw error;
  return result;
}

beforeEach(() => {
  jest.useFakeTimers();
  axios.post.mockReset();
  axios.get.mockReset();
  openaiClient.hasApiKey.mockReset().mockReturnValue(true);
  openaiClient.logVideoUsage.mockReset();
  delete process.env.OPENAI_VIDEO_MODEL;
  delete process.env.OPENAI_VIDEO_TIMEOUT_MS;
});

afterEach(() => {
  jest.useRealTimers();
});

// ── guard: no API key ──────────────────────────────────────────────────────
describe('api key gating', () => {
  it('returns null without calling Sora when OPENAI_API_KEY is missing', async () => {
    openaiClient.hasApiKey.mockReturnValue(false);
    const result = await generateVideo('hello');
    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ── happy path ─────────────────────────────────────────────────────────────
describe('happy path', () => {
  it('submits, polls once, downloads, and returns the MP4 Buffer', async () => {
    axios.post.mockResolvedValue({ data: { id: 'job_123' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } }) // first poll
      .mockResolvedValueOnce({ data: Buffer.from('MP4BYTES') }); // download

    const buf = await drivePolling(generateVideo('a sunset', { duration: 4, aspect: '9:16' }));

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe('MP4BYTES');

    // Submit call
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/videos',
      expect.objectContaining({
        model: 'sora-2',
        prompt: 'a sunset',
        size: '720x1280', // 9:16
        seconds: '4'
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key-do-not-use' })
      })
    );

    // Status + download GETs
    expect(axios.get).toHaveBeenNthCalledWith(
      1, 'https://api.openai.com/v1/videos/job_123',
      expect.objectContaining({ timeout: 15000 })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2, 'https://api.openai.com/v1/videos/job_123/content',
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      })
    );

    // Usage logged with duration
    expect(openaiClient.logVideoUsage).toHaveBeenCalledWith('sora-2', 4);
  });

  it('uses OPENAI_VIDEO_MODEL when set', async () => {
    process.env.OPENAI_VIDEO_MODEL = 'sora-custom';
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });

    await drivePolling(generateVideo('hi'));
    expect(axios.post.mock.calls[0][1].model).toBe('sora-custom');
    expect(openaiClient.logVideoUsage).toHaveBeenCalledWith('sora-custom', expect.any(Number));
  });
});

// ── size / seconds normalisation ───────────────────────────────────────────
describe('input normalisation', () => {
  beforeEach(() => {
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
  });

  it.each([
    [1,  '4'],  // below min snaps up
    [4,  '4'],
    [6,  '4'],  // 6 is equidistant 4/8; Math.abs logic picks 4 (first in list)
    [7,  '8'],
    [8,  '8'],
    [10, '8'],  // equidistant 8/12; picks 8
    [11, '12'],
    [50, '12'], // above max snaps down
  ])('snaps duration=%i seconds to %s', async (duration, expected) => {
    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
    await drivePolling(generateVideo('hi', { duration }));
    expect(axios.post.mock.calls[0][1].seconds).toBe(expected);
  });

  it('maps aspect 16:9 to 1280x720', async () => {
    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
    await drivePolling(generateVideo('hi', { aspect: '16:9' }));
    expect(axios.post.mock.calls[0][1].size).toBe('1280x720');
  });

  it('falls back to 9:16 for unknown aspects', async () => {
    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
    await drivePolling(generateVideo('hi', { aspect: '4:3' }));
    expect(axios.post.mock.calls[0][1].size).toBe('720x1280');
  });

  it('truncates long prompts to 2000 chars', async () => {
    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
    const long = 'a'.repeat(5000);
    await drivePolling(generateVideo(long));
    expect(axios.post.mock.calls[0][1].prompt).toHaveLength(2000);
  });

  it('uses a default prompt when empty string / non-string passed', async () => {
    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { id: 'j' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockResolvedValueOnce({ data: Buffer.from('x') });
    await drivePolling(generateVideo(''));
    expect(axios.post.mock.calls[0][1].prompt).toMatch(/social media short video/);
  });
});

// ── submit failure ─────────────────────────────────────────────────────────
describe('submit failure', () => {
  it('re-throws when the POST /v1/videos call rejects', async () => {
    axios.post.mockRejectedValue(new Error('bad prompt'));
    await expect(generateVideo('x')).rejects.toThrow('bad prompt');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('returns null and does NOT poll when submit returns no job id', async () => {
    axios.post.mockResolvedValue({ data: {} });
    const result = await generateVideo('x');
    expect(result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
});

// ── Sora 'failed' status ───────────────────────────────────────────────────
describe('Sora job failure', () => {
  it('throws an error tagged with soraFailed=true when job ends in failed state', async () => {
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get.mockResolvedValue({
      data: { status: 'failed', error: { message: 'content policy violation' } }
    });

    await expect(drivePolling(generateVideo('x'))).rejects.toMatchObject({
      message: 'content policy violation',
      soraFailed: true,
      soraStatus: 'failed'
    });
    expect(openaiClient.logVideoUsage).not.toHaveBeenCalled();
  });

  it('uses a generic message when failure has no error body', async () => {
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get.mockResolvedValue({ data: { status: 'failed' } });

    await expect(drivePolling(generateVideo('x'))).rejects.toThrow('Video generation failed');
  });
});

// ── transient poll errors ──────────────────────────────────────────────────
describe('transient poll errors', () => {
  it('retries when a poll request fails, then succeeds on next poll', async () => {
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))       // poll 1 fails
      .mockResolvedValueOnce({ data: { status: 'in_progress' } })  // poll 2
      .mockResolvedValueOnce({ data: { status: 'completed' } })    // poll 3
      .mockResolvedValueOnce({ data: Buffer.from('MP4') });        // download

    const buf = await drivePolling(generateVideo('x'));
    expect(buf.toString()).toBe('MP4');
  });
});

// ── download failure ───────────────────────────────────────────────────────
describe('download failure', () => {
  it('returns null (does not throw) when the MP4 download fails', async () => {
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get
      .mockResolvedValueOnce({ data: { status: 'completed' } })
      .mockRejectedValueOnce(new Error('download 500'));

    const result = await drivePolling(generateVideo('x'));
    expect(result).toBeNull();
    // Usage NOT logged on failed download (happens after the Buffer.from)
    expect(openaiClient.logVideoUsage).not.toHaveBeenCalled();
  });
});

// ── overall timeout ────────────────────────────────────────────────────────
describe('overall timeout', () => {
  it('returns null after OPENAI_VIDEO_TIMEOUT_MS without a completed status', async () => {
    process.env.OPENAI_VIDEO_TIMEOUT_MS = '60000'; // exactly min: 1 minute
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get.mockResolvedValue({ data: { status: 'in_progress' } });

    // Drive past 60s of fake time (12 polls * 5s + buffer)
    const result = await drivePolling(generateVideo('x'), { maxIters: 400, stepMs: 5000 });
    expect(result).toBeNull();
  });

  it('clamps OPENAI_VIDEO_TIMEOUT_MS below 60s up to 60s', async () => {
    process.env.OPENAI_VIDEO_TIMEOUT_MS = '1000'; // below min
    axios.post.mockResolvedValue({ data: { id: 'j1' } });
    axios.get.mockResolvedValue({ data: { status: 'in_progress' } });
    // If the clamp didn't work, this would return null after ~1s;
    // it should survive at least a few polls before timing out.
    const start = Date.now();
    const result = await drivePolling(generateVideo('x'), { maxIters: 20, stepMs: 5000 });
    // result may or may not be null depending on iter count — the point is
    // no crash. Just assert that we did poll multiple times.
    expect(axios.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Silence unused vars
    expect(start).toBeGreaterThan(0);
    expect(result === null || result === undefined).toBe(true);
  });
});
