const axios = require('axios');
const PlatformPost = require('../models/PlatformPost');
const BrandConfig = require('../models/BrandConfig');
const aiService = require('./aiService');
const logger = require('../config/logger');

const TEXT_ANALYSIS_SYSTEM_PROMPT = `You are a brand analyst. Given a set of social media post captions from one organization, analyze them and return a JSON object with these exact keys:

{
  "toneOfVoice": one of "professional","casual","friendly","authoritative","playful","inspirational","neutral",
  "writingStyle": short phrase describing the style (e.g. "conversational, question-driven, storytelling"),
  "emojiUsage": one of "heavy","moderate","minimal","none",
  "recurringEmojis": array of up to 6 most-used emoji names (e.g. ["fire","sparkles"]),
  "hashtagStrategy": { "avgCount": number, "branded": [array of branded hashtags], "generic": [array of generic hashtags] },
  "ctaStyle": array of CTA types used (e.g. ["link_in_bio","shop_now","learn_more","none"]),
  "personalityDescriptors": array of 5-8 brand personality words (e.g. ["bold","empathetic","modern"])
}

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation.
- Branded hashtags are unique to the brand. Generic ones are industry/topic hashtags.
- If insufficient data, still return the JSON with best guesses.`;

const VISUAL_ANALYSIS_SYSTEM_PROMPT = `You are a visual brand analyst. You will be shown images from a brand's social media posts. Analyze their visual identity and return a JSON object with these exact keys:

{
  "colorPalette": array of 3-5 dominant brand colors as hex codes (e.g. ["#1A1A2E","#E94560","#F5F5F5"]),
  "visualComposition": short phrase (e.g. "minimalist product-focused" or "lifestyle photography with text overlays"),
  "typographyStyle": short phrase (e.g. "bold sans-serif with minimal overlay"),
  "logoPlacement": short phrase (e.g. "bottom-right corner" or "none detected"),
  "imageMood": short phrase (e.g. "bright and airy, warm tones")
}

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation.
- If you cannot detect typography or logos, describe what you see.`;

function safeParseJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

class BrandProfileService {

  /**
   * Analyze an organization's recent posts and update BrandConfig.brandProfile.
   * @param {string} organizationId
   * @returns {{ success: boolean, analyzedCount: number, profile: object }}
   */
  async analyzeOrgContent(organizationId) {
    const posts = await PlatformPost.find({ organization: organizationId })
      .sort({ postedAt: -1 })
      .limit(10)
      .lean();

    if (!posts.length) {
      return { success: false, analyzedCount: 0, error: 'No synced posts found. Sync your platforms first.' };
    }

    const textResult = await this._analyzeText(posts);
    const visualResult = await this._analyzeVisuals(posts);

    const count = posts.length;
    let confidence = 'low';
    if (count >= 10) confidence = 'high';
    else if (count >= 5) confidence = 'medium';

    const profile = {
      writingStyle: textResult?.writingStyle || '',
      emojiUsage: textResult?.emojiUsage || 'moderate',
      recurringEmojis: textResult?.recurringEmojis || [],
      hashtagStrategy: textResult?.hashtagStrategy || { avgCount: 0, branded: [], generic: [] },
      ctaStyle: textResult?.ctaStyle || [],
      personalityDescriptors: textResult?.personalityDescriptors || [],

      colorPalette: visualResult?.colorPalette || [],
      visualComposition: visualResult?.visualComposition || '',
      typographyStyle: visualResult?.typographyStyle || '',
      logoPlacement: visualResult?.logoPlacement || '',
      imageMood: visualResult?.imageMood || '',

      analyzedPostCount: count,
      analyzedAt: new Date(),
      confidence
    };

    const updatedConfig = await BrandConfig.findOneAndUpdate(
      { organization: organizationId },
      { $set: { brandProfile: profile } },
      { new: true, upsert: true }
    );

    if (textResult?.toneOfVoice && !updatedConfig.toneOfVoice) {
      await BrandConfig.updateOne(
        { organization: organizationId },
        { $set: { toneOfVoice: textResult.toneOfVoice } }
      );
    }

    return { success: true, analyzedCount: count, profile };
  }

  /** @private */
  async _analyzeText(posts) {
    const captions = posts
      .filter(p => p.text && p.text.trim())
      .map((p, i) => `Post ${i + 1}:\n${p.text.trim()}`)
      .join('\n\n---\n\n');

    if (!captions) return null;

    try {
      const response = await aiService._postChatCompletions(
        {
          model: aiService.openaiModel,
          messages: [
            { role: 'system', content: TEXT_ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content: `Analyze these ${posts.length} social media captions:\n\n${captions}` }
          ],
          ...this._tokenConfig(800)
        },
        { feature: 'brand_profile.text_analysis' }
      );
      const text = response.data?.choices?.[0]?.message?.content;
      return safeParseJSON(text);
    } catch (err) {
      logger.error('Brand profile text analysis failed', { error: err.message });
      return null;
    }
  }

  /** @private */
  async _analyzeVisuals(posts) {
    const candidates = posts
      .filter(p => p.mediaUrl && (p.mediaType === 'image' || p.mediaType === 'carousel'))
      .slice(0, 5);

    if (!candidates.length) return null;

    // Download images and convert to base64 data URLs.
    // Social platform CDN URLs (Instagram/Facebook) are often short-lived signed URLs
    // that OpenAI cannot fetch, so we must inline them.
    const imageContents = [];
    for (const post of candidates) {
      try {
        const resp = await axios.get(post.mediaUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const mime = resp.headers['content-type'] || 'image/jpeg';
        const b64 = Buffer.from(resp.data).toString('base64');
        imageContents.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'low' } });
      } catch (dlErr) {
        logger.warn('Brand visual analysis: could not download image, skipping', {
          url: post.mediaUrl?.substring(0, 120),
          error: dlErr.message
        });
      }
    }

    if (!imageContents.length) {
      logger.warn('Brand visual analysis: no images could be downloaded, skipping visual analysis');
      return null;
    }

    const content = [
      { type: 'text', text: `Analyze the visual style across these ${imageContents.length} brand images.` },
      ...imageContents
    ];

    try {
      const response = await aiService._postChatCompletions(
        {
          model: aiService.visionModel,
          messages: [
            { role: 'system', content: VISUAL_ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content }
          ],
          max_tokens: 500
        },
        { feature: 'brand_profile.visual_analysis' },
        { timeout: 90000 }
      );
      const text = response.data?.choices?.[0]?.message?.content;
      return safeParseJSON(text);
    } catch (err) {
      const detail = err.response?.data || err.response?.status || err.message;
      logger.error('Brand profile visual analysis failed', {
        error: err.message,
        status: err.response?.status,
        openaiError: JSON.stringify(detail),
        model: aiService.visionModel,
        imageCount: imageContents.length
      });
      return null;
    }
  }

  /** @private — token field helper compatible with GPT-5 family */
  _tokenConfig(max) {
    const model = aiService.openaiModel || '';
    const useNew = /^gpt-5|^o[134]/.test(model.toLowerCase());
    return useNew ? { max_completion_tokens: max } : { max_tokens: max };
  }
}

module.exports = new BrandProfileService();
