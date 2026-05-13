'use strict';

/**
 * Voice Gateway — WebSocket server that consumes Twilio Media Streams,
 * runs STT → LLM → TTS turns, and streams audio back to Twilio in real time.
 *
 * Mount point: wss://<host>/voice/stream
 * Twilio sends 8 kHz mulaw frames; we convert via ffmpeg to 16 kHz WAV for Sarvam STT
 * and back to mulaw 8 kHz for the return stream.
 */

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const CallSession = require('../models/CallSession');
const VoiceAgent = require('../models/VoiceAgent');
const PhoneNumber = require('../models/PhoneNumber');
const VoicePhoneCredential = require('../models/VoicePhoneCredential');
const sarvamService = require('../integrations/voice/sarvamService');
const openaiVoiceService = require('../integrations/voice/openaiVoiceService');
const voiceAiKeys = require('../integrations/voice/voiceAiKeys');
const voiceConversationEngine = require('./voiceConversationEngine');
const { emitToOrg } = require('../utils/socketEmitter');
const logger = require('../config/logger');

const svcLogger = logger.createChild({ module: 'voiceGatewayService' });

// ─── Tuning ──────────────────────────────────────────────────────────────────
const SILENCE_WINDOW_MS = 700;           // VAD: how long of "low energy" frames before we flush
const MIN_UTTERANCE_MS = 600;            // ignore noise blips shorter than this
const MAX_UTTERANCE_MS = 12000;          // hard flush — prevents runaway buffers
const FRAME_DURATION_MS = 20;            // Twilio sends 20 ms frames

// ─── ffmpeg helpers ──────────────────────────────────────────────────────────

/** mulaw 8kHz → WAV 16kHz mono PCM */
function muLawBufferToWav16k(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mulaw', '-ar', '8000', '-ac', '1',
      '-i', 'pipe:0',
      '-ar', '16000', '-ac', '1',
      '-f', 'wav', 'pipe:1'
    ];
    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', () => {});
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}`));
    });
    ff.stdin.write(mulawBuffer);
    ff.stdin.end();
  });
}

/** Arbitrary audio (WAV/MP3/Opus) → raw mulaw 8 kHz frames suitable for Twilio Media Streams */
function anyAudioToMulaw8k(audioBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ar', '8000', '-ac', '1',
      '-f', 'mulaw', 'pipe:1'
    ];
    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', () => {});
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}`));
    });
    ff.stdin.write(audioBuffer);
    ff.stdin.end();
  });
}

// ─── VAD helpers ─────────────────────────────────────────────────────────────

/**
 * Very small VAD: average absolute amplitude in a mulaw frame.
 * mulaw is 8-bit; 0xff is silence. We treat anything above a small threshold as voice.
 */
function frameIsVoice(mulawFrame) {
  let energy = 0;
  for (let i = 0; i < mulawFrame.length; i++) {
    // Convert mulaw byte to linear amplitude magnitude rough proxy
    const v = (mulawFrame[i] ^ 0xff) & 0x7f;
    energy += v;
  }
  const avg = energy / Math.max(mulawFrame.length, 1);
  return avg > 8; // empirically: silence avg ~ 0–3, speech ~ 10+
}

// ─── Per-call session ────────────────────────────────────────────────────────

class CallStreamSession {
  constructor(ws) {
    this.ws = ws;
    this.callSid = null;
    this.streamSid = null;
    this.organizationId = null;
    this.agent = null;
    this.callSession = null;
    this.credential = null;
    this.buffer = [];             // queued mulaw frames during current utterance
    this.utteranceMs = 0;
    this.silenceMs = 0;
    this.inUtterance = false;
    this.processing = false;      // backpressure flag
    this.closed = false;
  }

  async start({ callSid, streamSid, customParameters }) {
    this.callSid = callSid;
    this.streamSid = streamSid;

    // Resolve the CallSession created by the /webhooks/incoming handler
    const session = await CallSession.findOne({ twilioCallSid: callSid });
    if (!session) {
      svcLogger.warn('[voiceGateway] No CallSession for sid — closing', { callSid });
      this.close();
      return;
    }
    this.callSession = session;
    this.organizationId = session.organization;

    const agentId = customParameters?.agentId || session.agent;
    this.agent = agentId ? await VoiceAgent.findById(agentId) : null;
    if (!this.agent) {
      svcLogger.warn('[voiceGateway] No agent — closing', { callSid });
      this.close();
      return;
    }

    this.credential = await VoicePhoneCredential.findOne({
      organization: this.organizationId
    }).lean();
    if (!this.credential) {
      svcLogger.warn('[voiceGateway] No credential — closing', { callSid });
      this.close();
      return;
    }

    session.status = 'in-progress';
    session.twilioStreamSid = streamSid;
    await session.save();

    emitToOrg(String(this.organizationId), 'voice_call_started', {
      callSessionId: session._id,
      agentId: this.agent._id,
      callerNumber: session.callerNumber,
      direction: session.direction
    });

    // Initialize Redis session
    await voiceConversationEngine.initSession(callSid, {
      messages: [{ role: 'system', content: this.agent.systemPrompt }],
      language: this.agent.language || 'en-IN'
    });

    // Speak greeting (handled by TwiML <Say> before <Stream>, so nothing to do here)
  }

  handleMedia(payloadB64) {
    if (this.closed) return;
    const frame = Buffer.from(payloadB64, 'base64');
    const voice = frameIsVoice(frame);

    if (voice) {
      if (!this.inUtterance) {
        this.inUtterance = true;
        this.utteranceMs = 0;
        this.silenceMs = 0;
        this.buffer = [];
      }
      this.buffer.push(frame);
      this.utteranceMs += FRAME_DURATION_MS;
      this.silenceMs = 0;
    } else if (this.inUtterance) {
      this.buffer.push(frame);
      this.utteranceMs += FRAME_DURATION_MS;
      this.silenceMs += FRAME_DURATION_MS;
    }

    if (this.inUtterance && (
      (this.silenceMs >= SILENCE_WINDOW_MS && this.utteranceMs >= MIN_UTTERANCE_MS) ||
      this.utteranceMs >= MAX_UTTERANCE_MS
    )) {
      this.flushUtterance();
    }
  }

  async flushUtterance() {
    if (this.processing || !this.inUtterance) return;
    const mulaw = Buffer.concat(this.buffer);
    this.buffer = [];
    this.inUtterance = false;
    this.utteranceMs = 0;
    this.silenceMs = 0;
    if (mulaw.length === 0) return;

    this.processing = true;
    try {
      await this.handleUtterance(mulaw);
    } catch (err) {
      svcLogger.error('[voiceGateway] Turn failed', { error: err.message, callSid: this.callSid });
    } finally {
      this.processing = false;
    }
  }

  async handleUtterance(mulawAudio) {
    // 1. Convert + STT
    const wav16k = await muLawBufferToWav16k(mulawAudio);
    const sttResult = await this.runStt(wav16k);
    const transcript = (sttResult?.transcript || '').trim();
    if (!transcript) return;

    svcLogger.debug('[voiceGateway] User said', { callSid: this.callSid, transcript });

    // Append to transcript log (non-blocking is fine here)
    await CallSession.updateOne(
      { _id: this.callSession._id },
      {
        $push: {
          transcript: {
            role: 'user',
            text: transcript,
            timestamp: new Date(),
            languageDetected: sttResult.languageDetected
          }
        }
      }
    ).catch(() => {});

    // 2. LLM turn
    const turn = await voiceConversationEngine.processTurn({
      callSid: this.callSid,
      transcript,
      languageDetected: sttResult.languageDetected,
      agent: this.agent,
      session: this.callSession,
      credential: this.credential
    });

    await CallSession.updateOne(
      { _id: this.callSession._id },
      {
        $push: {
          transcript: {
            role: 'assistant',
            text: turn.replyText,
            timestamp: new Date(),
            languageDetected: turn.languageOut
          }
        },
        $addToSet: { toolCallsUsed: { $each: turn.toolsInvoked || [] } }
      }
    ).catch(() => {});

    // 3. TTS + send back to Twilio
    await this.speak(turn.replyText, turn.languageOut);

    // 4. Handoff path: hang up after farewell
    if (turn.handoff) {
      await CallSession.updateOne(
        { _id: this.callSession._id },
        { $set: { humanHandoffTriggered: true } }
      );
      setTimeout(() => this.close(), 500);
    }
  }

  async runStt(wavBuffer) {
    const sarvamKey = voiceAiKeys.getPlatformSarvamKey();
    if (sarvamKey) {
      try {
        return await sarvamService.transcribe({
          audioBuffer: wavBuffer,
          apiKey: sarvamKey,
          language: 'unknown'
        });
      } catch (err) {
        svcLogger.warn('[voiceGateway] STT failed, trying fallback', { error: err.message });
      }
    }
    const openaiKey = voiceAiKeys.getPlatformOpenAiKey();
    if (openaiKey) {
      return await openaiVoiceService.transcribe({
        audioBuffer: wavBuffer,
        apiKey: openaiKey
      });
    }
    return { transcript: '', languageDetected: null };
  }

  async speak(text, language) {
    if (!text) return;
    let audioWav;
    try {
      const sarvamKey = voiceAiKeys.getPlatformSarvamKey();
      if (sarvamKey) {
        audioWav = await sarvamService.synthesize({
          text,
          apiKey: sarvamKey,
          voiceId: this.agent.voiceId || 'meera',
          language: language || this.agent.language || 'en-IN'
        });
      } else {
        const openaiKey = voiceAiKeys.getPlatformOpenAiKey();
        if (openaiKey) {
          audioWav = await openaiVoiceService.synthesize({
            text,
            apiKey: openaiKey
          });
        }
      }
    } catch (err) {
      svcLogger.warn('[voiceGateway] TTS failed', { error: err.message });
      return;
    }
    if (!audioWav || audioWav.length === 0) return;

    let mulaw;
    try {
      mulaw = await anyAudioToMulaw8k(audioWav);
    } catch (err) {
      svcLogger.warn('[voiceGateway] ffmpeg mulaw conv failed', { error: err.message });
      return;
    }

    // Stream in 160-byte chunks (20 ms of mulaw 8 kHz)
    const CHUNK_SIZE = 160;
    for (let i = 0; i < mulaw.length; i += CHUNK_SIZE) {
      if (this.closed) return;
      const chunk = mulaw.subarray(i, i + CHUNK_SIZE);
      this.ws.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: chunk.toString('base64') }
      }));
      // Small pace — keeps Twilio jitter buffer happy without blocking event loop
      await sleep(FRAME_DURATION_MS);
    }

    this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: `t-${Date.now()}` } }));
  }

  async stop() {
    if (!this.callSession) return;
    const endedAt = new Date();
    const durationSeconds = Math.max(
      1,
      Math.round((endedAt.getTime() - this.callSession.startedAt.getTime()) / 1000)
    );
    await CallSession.updateOne(
      { _id: this.callSession._id },
      {
        $set: {
          endedAt,
          durationSeconds,
          status: 'completed'
        }
      }
    ).catch(() => {});

    await voiceConversationEngine.clearSession(this.callSid).catch(() => {});

    emitToOrg(String(this.organizationId), 'voice_call_completed', {
      callSessionId: this.callSession._id,
      durationSeconds
    });

    // Hand off to post-call worker for summary/analytics/follow-up
    try {
      const { voiceCallQueue } = require('../config/queue');
      if (voiceCallQueue) {
        await voiceCallQueue.add({ callSessionId: String(this.callSession._id) });
      }
    } catch (err) {
      svcLogger.warn('[voiceGateway] Could not enqueue voice-call post-job', { error: err.message });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch (_) {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Attach the WebSocket server to an existing http.Server.
 * @param {import('http').Server} httpServer
 */
function attach(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    if (!request.url || !request.url.startsWith('/voice/stream')) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    const session = new CallStreamSession(ws);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      switch (msg.event) {
        case 'connected':
          break;
        case 'start':
          await session.start({
            callSid: msg.start?.callSid,
            streamSid: msg.start?.streamSid,
            customParameters: msg.start?.customParameters || {}
          });
          break;
        case 'media':
          session.handleMedia(msg.media?.payload || '');
          break;
        case 'mark':
          break;
        case 'stop':
          await session.stop();
          session.close();
          break;
        default:
          break;
      }
    });

    ws.on('close', async () => {
      if (!session.closed) {
        try { await session.stop(); } catch (_) {}
        session.closed = true;
      }
    });

    ws.on('error', (err) => {
      svcLogger.warn('[voiceGateway] socket error', { error: err.message });
    });
  });

  svcLogger.info('[voiceGateway] attached at /voice/stream');
}

module.exports = { attach };
