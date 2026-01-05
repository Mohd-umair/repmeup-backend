const axios = require('axios');

class AIService {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.apiUrl = 'https://api.openai.com/v1/chat/completions';
    this.model = 'gpt-4';
  }

  /**
   * Analyze sentiment of text
   */
  async analyzeSentiment(content) {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'You are a sentiment analysis expert. Analyze the sentiment of the given text and respond with ONLY one word: "positive", "negative", or "neutral". Also provide a confidence score from 0 to 1.'
            },
            {
              role: 'user',
              content: `Analyze the sentiment of this text: "${content}"`
            }
          ],
          temperature: 0.3,
          max_tokens: 50
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = response.data.choices[0].message.content.toLowerCase().trim();
      
      // Extract sentiment
      let sentiment = 'neutral';
      if (result.includes('positive')) sentiment = 'positive';
      else if (result.includes('negative')) sentiment = 'negative';
      
      // Calculate score based on sentiment
      const sentimentScore = sentiment === 'positive' ? 0.8 : sentiment === 'negative' ? -0.8 : 0;
      
      return {
        sentiment,
        sentimentScore,
        sentimentConfidence: 0.85 // Default confidence
      };
    } catch (error) {
      console.error('Sentiment analysis error:', error.message);
      return {
        sentiment: 'neutral',
        sentimentScore: 0,
        sentimentConfidence: 0.5
      };
    }
  }

  /**
   * Generate AI response based on interaction and knowledge base
   */
  async generateResponse(interaction, knowledgeBase = []) {
    try {
      // Build context from knowledge base
      const kbContext = knowledgeBase
        .map(kb => `${kb.title}: ${kb.content}`)
        .join('\n\n');

      const systemPrompt = `You are a professional customer service representative. 
Your task is to generate a helpful, friendly, and professional response to customer inquiries.

IMPORTANT GUIDELINES:
- Be polite, empathetic, and professional
- Keep responses concise (2-3 sentences max)
- Use a friendly tone
- Address the customer's concern directly
- Do not make promises you can't keep
${kbContext ? `\n\nKNOWLEDGE BASE:\n${kbContext}` : ''}

Generate a response that addresses the customer's message appropriately.`;

      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: `Customer message: "${interaction.content}"\n\nPlatform: ${interaction.platform}\nSentiment: ${interaction.sentiment || 'unknown'}`
            }
          ],
          temperature: 0.7,
          max_tokens: 200
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const generatedResponse = response.data.choices[0].message.content.trim();
      
      return {
        content: generatedResponse,
        confidence: 0.8,
        generatedAt: new Date()
      };
    } catch (error) {
      console.error('AI response generation error:', error.message);
      return null;
    }
  }

  /**
   * Detect intent/category of interaction
   */
  async detectIntent(content) {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'Classify the intent of this message. Respond with ONLY one word: "inquiry", "complaint", "praise", "feedback", "support", or "other".'
            },
            {
              role: 'user',
              content: `Classify: "${content}"`
            }
          ],
          temperature: 0.3,
          max_tokens: 10
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const intent = response.data.choices[0].message.content.toLowerCase().trim();
      const validIntents = ['inquiry', 'complaint', 'praise', 'feedback', 'support'];
      
      return validIntents.includes(intent) ? intent : 'other';
    } catch (error) {
      console.error('Intent detection error:', error.message);
      return 'other';
    }
  }

  /**
   * Extract topics/keywords from text
   */
  async extractTopics(content) {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: 'Extract 2-3 main topics or keywords from the text. Return them as a comma-separated list.'
            },
            {
              role: 'user',
              content: `Extract topics: "${content}"`
            }
          ],
          temperature: 0.3,
          max_tokens: 50
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const topicsStr = response.data.choices[0].message.content.trim();
      return topicsStr.split(',').map(t => t.trim()).filter(t => t);
    } catch (error) {
      console.error('Topic extraction error:', error.message);
      return [];
    }
  }

  /**
   * Determine if interaction is eligible for auto-reply
   */
  canAutoReply(interaction) {
    // Don't auto-reply to negative sentiment
    if (interaction.sentiment === 'negative') {
      return false;
    }

    // Don't auto-reply if confidence is too low
    if (interaction.sentimentConfidence < 0.7) {
      return false;
    }

    // Don't auto-reply to complaints
    if (interaction.intent === 'complaint') {
      return false;
    }

    // Don't auto-reply if urgency is high
    if (interaction.urgency === 'urgent' || interaction.urgency === 'high') {
      return false;
    }

    return true;
  }
}

module.exports = new AIService();

