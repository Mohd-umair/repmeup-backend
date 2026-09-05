const aiService = require('./aiService');

/**
 * ContentSummarizerService - Single Responsibility Principle
 * Handles AI-powered content summarization
 * 
 * This service is responsible ONLY for:
 * - Summarizing long content using AI
 * - Extracting key points
 * - Generating structured summaries
 * - Maintaining context and quality
 */
class ContentSummarizerService {
  constructor() {
    this.maxInputLength = 15000; // ~3000 words (AI context limit)
    this.minSummaryLength = 200; // Minimum summary length
    this.maxSummaryLength = 40000; // Maximum summary length (supports up to ~8000 words)
  }

  /**
   * Summarize content using AI
   * @param {string} content - Content to summarize
   * @param {Object} options - Summarization options
   * @param {string} options.title - Title of the content (for context)
   * @param {string} options.url - Source URL (for context)
   * @param {string} options.focus - What to focus on (e.g., 'key_points', 'overview', 'detailed')
   * @returns {Promise<Object>} Summary with metadata
   */
  async summarize(content, options = {}) {
    try {
      if (!content || content.trim().length < 100) {
        throw new Error('Content is too short to summarize. Minimum 100 characters required.');
      }

      // Truncate if too long (to fit in AI context)
      const truncatedContent = this._truncateContent(content, this.maxInputLength);
      
      // Generate summary using AI
      const summary = await this._generateSummary(truncatedContent, options);

      // Extract key points
      const keyPoints = await this._extractKeyPoints(truncatedContent, summary);

      // Generate tags/keywords
      const tags = await this._extractTags(truncatedContent, summary, options);

      return {
        summary: summary.trim(),
        keyPoints: keyPoints,
        tags: tags,
        originalLength: content.length,
        summaryLength: summary.length,
        compressionRatio: (summary.length / content.length * 100).toFixed(1) + '%',
        generatedAt: new Date()
      };
    } catch (error) {
      console.error('Content summarization error:', error.message);
      throw new Error(`Failed to summarize content: ${error.message}`);
    }
  }

  /**
   * Generate summary using AI
   * @private
   */
  async _generateSummary(content, options) {
    const { title, url, focus = 'overview', targetWordCount } = options;

    // Adjust style and maxTokens based on target word count
    const requestedWords = targetWordCount ? parseInt(targetWordCount, 10) : 500;
    const isShortSummary = requestedWords <= 1000;
    const isMediumSummary = requestedWords > 1000 && requestedWords <= 2500;
    const isLongSummary = requestedWords > 2500;

    // Calculate maxTokens: roughly 1.3 tokens per word + buffer
    const calculatedMaxTokens = Math.ceil(requestedWords * 1.3) + 500;
    const maxTokens = Math.min(Math.max(1000, calculatedMaxTokens), 8000);

    // Build prompt based on focus and length
    let promptInstruction = '';
    if (isShortSummary) {
      promptInstruction = 'Create a concise summary that captures the key information.';
    } else if (isMediumSummary) {
      promptInstruction = 'Create a comprehensive summary with important details and context.';
    } else {
      promptInstruction = 'Create an extensive, detailed summary that thoroughly covers all aspects of the content.';
    }

    switch (focus) {
      case 'key_points':
        promptInstruction += ' Focus on extracting the most important key points and facts.';
        break;
      case 'detailed':
        promptInstruction += ' Include all important details, examples, and explanations.';
        break;
      case 'overview':
      default:
        promptInstruction += ' Provide a clear overview of the main topics and information.';
    }

    const lengthGuidance = targetWordCount
      ? `- Your summary MUST be approximately ${targetWordCount} words (this is critical - do not make it shorter).
- If the content is shorter than ${targetWordCount} words, elaborate on key points and provide additional context to reach the target.
- Count your words and ensure you meet the target length requirement.`
      : `- Aim for a comprehensive summary (preferably between ${this.minSummaryLength} and ${this.maxSummaryLength} characters)`;

    const systemPrompt = `You are an expert content writer and summarizer. Your task is to process web content and create a ${targetWordCount ? targetWordCount + '-word' : 'comprehensive'} summary.

CRITICAL REQUIREMENTS:
${lengthGuidance}
- ${promptInstruction}
- Use clear, professional language
- Maintain important facts, numbers, and key information
- Complete all sentences and thoughts - do not cut off mid-sentence
- Organize information logically with proper structure
- Do not include personal opinions or interpretations
- Focus on factual information and main topics

FORMAT:
- Write in paragraph form (use multiple paragraphs for better readability)
- Use proper grammar and punctuation
- Make it easy to read and understand
- For longer summaries (2000+ words), organize into sections if appropriate`;

    // Truncate very large inputs to prevent excessive prompt token usage
    const MAX_SUMMARY_INPUT = 12000;
    const inputContent = content.length > MAX_SUMMARY_INPUT
      ? content.substring(0, MAX_SUMMARY_INPUT) + '\n…[content truncated for length]'
      : content;

    const userPrompt = `Create a ${targetWordCount || 500}-word summary of the following content${title ? ` from "${title}"` : ''}${url ? ` (Source: ${url})` : ''}:

${inputContent}

Remember: Your summary MUST be approximately ${targetWordCount || 500} words. This is a strict requirement.`;

    try {
      console.log(`🤖 [Summarizer] Calling AI service (target: ${requestedWords} words, maxTokens: ${maxTokens})...`);
      let summary = await aiService.generateText(systemPrompt, userPrompt, {
        temperature: 0.3,
        maxTokens: maxTokens,
        feature: 'knowledge_base.summarize'
      });
      const wordCount = summary.trim().split(/\s+/).length;
      console.log(`✅ [Summarizer] AI summary received: ${summary.length} characters, ~${wordCount} words (target: ${requestedWords} words)`);

      // Validate minimum length only (no upper truncation when user requested specific length)
      if (summary.length < this.minSummaryLength) {
        console.warn(`⚠️ [Summarizer] Summary too short (${summary.length} chars, ${wordCount} words). Minimum: ${this.minSummaryLength} chars`);
        throw new Error(`Summary too short (${summary.length} chars, ${wordCount} words). Minimum: ${this.minSummaryLength} chars`);
      }

      // Warn if very long but don't truncate (user requested this length)
      if (summary.length > this.maxSummaryLength) {
        console.warn(`⚠️ [Summarizer] Summary is very long: ${summary.length} characters (~${wordCount} words). This is fine if user requested it.`);
      }

      return summary;
    } catch (error) {
      // Fallback to basic summarization if AI fails
      console.warn(`⚠️ [Summarizer] AI summarization failed, using fallback: ${error.message}`);
      const fallbackSummary = this._fallbackSummary(content);
      console.log(`✅ [Summarizer] Fallback summary generated: ${fallbackSummary.length} characters`);
      return fallbackSummary;
    }
  }

  /**
   * Extract key points from content
   * @private
   */
  async _extractKeyPoints(content, summary) {
    try {
      const prompt = `Extract 5-7 key points from this content. Return ONLY a JSON array of strings, no other text:

Content: ${content.substring(0, 5000)}

Format: ["Point 1", "Point 2", "Point 3"]`;

      // Use AI to extract key points
      try {
        const response = await aiService.generateText(
          'You are a data extraction assistant. Extract key points and return ONLY a valid JSON array of strings.',
          prompt,
          { temperature: 0.2, maxTokens: 500, feature: 'knowledge_base.key_points' }
        );

        // Try to parse JSON from response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        // Fall through to basic extraction
      }

      // Fallback: Extract from summary
      return this._extractKeyPointsFromSummary(summary);
    } catch (error) {
      console.warn('Key points extraction failed:', error.message);
      return this._extractKeyPointsFromSummary(summary);
    }
  }

  /**
   * Extract tags/keywords from content
   * @private
   */
  async _extractTags(content, summary, options = {}) {
    const { targetTagCount } = options;
    const tagLimit = targetTagCount ? Math.min(Math.max(1, parseInt(targetTagCount, 10)), 30) : 10;
    try {
      const prompt = `Extract up to ${tagLimit} relevant tags/keywords from this content. Return ONLY a JSON array of strings, no other text:

Content: ${summary}

Format: ["tag1", "tag2", "tag3"]`;

      try {
        const response = await aiService.generateText(
          'You are a keyword extraction assistant. Extract relevant tags and return ONLY a valid JSON array of strings.',
          prompt,
          { temperature: 0.2, maxTokens: 300, feature: 'knowledge_base.tags' }
        );

        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        // Fall through
      }

      // Fallback: Extract from summary text
      return this._extractTagsFromText(summary);
    } catch (error) {
      console.warn('Tag extraction failed:', error.message);
      return this._extractTagsFromText(summary);
    }
  }

  /**
   * Fallback summary method (if AI fails)
   * @private
   */
  _fallbackSummary(content) {
    // Simple extractive summarization
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    
    // Take first few sentences and middle sentences
    const summaryLength = Math.min(this.maxSummaryLength, Math.max(this.minSummaryLength, content.length * 0.3));
    const selectedSentences = [
      ...sentences.slice(0, 2), // First 2 sentences
      ...sentences.slice(Math.floor(sentences.length / 2), Math.floor(sentences.length / 2) + 2) // Middle 2 sentences
    ];

    let summary = selectedSentences.join('. ').trim();
    
    if (summary.length < this.minSummaryLength) {
      // Add more sentences if needed
      summary = sentences.slice(0, Math.ceil(this.minSummaryLength / 50)).join('. ').trim();
    }

    return summary.substring(0, this.maxSummaryLength);
  }

  /**
   * Extract key points from summary (fallback)
   * @private
   */
  _extractKeyPointsFromSummary(summary) {
    const sentences = summary.split(/[.!?]+/).filter(s => s.trim().length > 20);
    return sentences.slice(0, 7).map(s => s.trim()).filter(s => s.length > 0);
  }

  /**
   * Extract tags from text (fallback)
   * @private
   */
  _extractTagsFromText(text) {
    // Simple keyword extraction
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4); // Only words longer than 4 chars

    // Count word frequency
    const wordFreq = {};
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });

    // Get top words
    const tags = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    return tags;
  }

  /**
   * Truncate content to fit AI context
   * @private
   */
  _truncateContent(content, maxLength) {
    if (content.length <= maxLength) {
      return content;
    }

    // Try to truncate at sentence boundary
    const truncated = content.substring(0, maxLength);
    const lastSentence = truncated.lastIndexOf('.');
    
    if (lastSentence > maxLength * 0.8) {
      return truncated.substring(0, lastSentence + 1);
    }

    return truncated + '...';
  }
}

// Export singleton instance (Dependency Injection ready)
module.exports = new ContentSummarizerService();

