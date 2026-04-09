const EventTemplate = require('../models/EventTemplate');
const storageService = require('../services/storageService');
const aiService = require('../services/aiService');
const logger = require('../config/logger');

const EVENT_STYLE_PROMPT = `Analyze this seasonal/event reference image and return a JSON object:
{
  "dominantColors": ["#hex1","#hex2","#hex3"],
  "decorativeElements": ["element1","element2"],
  "typography": "description of any text/font style",
  "layoutPattern": "description of layout",
  "mood": "single phrase describing mood and feeling"
}
Return ONLY valid JSON.`;

exports.list = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const templates = await EventTemplate.find({ organization: orgId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const { name, eventType } = req.body;
    if (!name || !eventType) {
      return res.status(400).json({ success: false, error: 'name and eventType are required' });
    }

    let referenceImageUrl = null;
    let s3Key = null;
    if (req.file) {
      if (storageService.isS3Configured()) {
        s3Key = `event-templates/${orgId}/${Date.now()}-${req.file.originalname}`;
        const result = await storageService.uploadBuffer(s3Key, req.file.buffer, req.file.mimetype);
        referenceImageUrl = result.publicUrl || result.url;
      } else {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '../../uploads/event-templates');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = `${orgId}-${Date.now()}-${req.file.originalname}`;
        fs.writeFileSync(path.join(dir, filename), req.file.buffer);
        referenceImageUrl = `${process.env.BASE_URL || 'http://localhost:5000'}/uploads/event-templates/${filename}`;
      }
    }

    const template = await EventTemplate.create({
      organization: orgId,
      name,
      eventType,
      referenceImageUrl,
      s3Key
    });

    if (referenceImageUrl) {
      _analyzeEventImageAsync(template._id, referenceImageUrl).catch(err =>
        logger.warn('Event template image analysis failed', { id: template._id, err: err.message })
      );
    }

    res.status(201).json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const update = {};
    if (req.body.name) update.name = req.body.name;
    if (req.body.eventType) update.eventType = req.body.eventType;
    if (req.body.isActive !== undefined) update.isActive = req.body.isActive;

    const doc = await EventTemplate.findOneAndUpdate(
      { _id: req.params.id, organization: orgId },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Template not found' });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await EventTemplate.findOneAndDelete({ _id: req.params.id, organization: orgId });
    if (!doc) return res.status(404).json({ success: false, error: 'Template not found' });
    if (doc.s3Key) storageService.deleteObjectByKey(doc.s3Key).catch(() => {});
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

async function _analyzeEventImageAsync(templateId, imageUrl) {
  try {
    const response = await aiService._postChatCompletions(
      {
        model: aiService.visionModel,
        messages: [
          { role: 'system', content: EVENT_STYLE_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze this seasonal/event reference image.' },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }
          ]}
        ],
        max_tokens: 400
      },
      { feature: 'event_template.image_analysis' },
      { timeout: 60000 }
    );
    const text = response.data?.choices?.[0]?.message?.content;
    const parsed = _safeJSON(text);
    if (parsed) {
      await EventTemplate.updateOne({ _id: templateId }, { $set: { eventStyle: parsed } });
    }
  } catch (err) {
    logger.warn('Event template AI analysis error', { templateId, error: err.message });
  }
}

function _tokenCfg(max) {
  const m = (aiService.openaiModel || '').toLowerCase();
  return /^gpt-5|^o[134]/.test(m) ? { max_completion_tokens: max } : { max_tokens: max };
}

function _safeJSON(text) {
  if (!text) return null;
  let c = text.trim();
  const m = c.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) c = m[1].trim();
  try { return JSON.parse(c); } catch { return null; }
}
