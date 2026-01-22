const axios = require('axios');
const cheerio = require('cheerio');

/**
 * WebScraperService - Single Responsibility Principle
 * Handles web scraping and content extraction from URLs
 * 
 * This service is responsible ONLY for:
 * - Fetching web pages
 * - Extracting structured content
 * - Cleaning HTML
 * - Returning raw content for further processing
 */
class WebScraperService {
  constructor() {
    this.defaultTimeout = 15000; // 15 seconds
    this.maxContentLength = 500000; // 500KB max content
    this.userAgent = 'Mozilla/5.0 (compatible; ORM-Bot/1.0; +https://repmeup.in)';
  }

  /**
   * Scrape a URL and extract structured content
   * @param {string} url - The URL to scrape
   * @returns {Promise<Object>} Scraped content with metadata
   */
  async scrape(url) {
    try {
      // Validate URL
      this._validateURL(url);

      // Fetch the page
      const response = await axios.get(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: this.defaultTimeout,
        maxContentLength: this.maxContentLength,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400
      });

      // Parse HTML
      const $ = cheerio.load(response.data);

      // Extract structured content
      const scrapedData = {
        url: url,
        title: this._extractTitle($),
        description: this._extractDescription($),
        content: this._extractMainContent($),
        metadata: this._extractMetadata($),
        scrapedAt: new Date()
      };

      // Validate extracted content
      if (!scrapedData.content || scrapedData.content.trim().length < 50) {
        throw new Error('Insufficient content extracted from URL. The page may be empty or require JavaScript rendering.');
      }

      return scrapedData;
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to fetch URL: ${error.response.status} ${error.response.statusText}`);
      } else if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout. The website took too long to respond.');
      } else if (error.code === 'ENOTFOUND') {
        throw new Error('URL not found. Please check the URL and try again.');
      } else {
        throw new Error(`Scraping failed: ${error.message}`);
      }
    }
  }

  /**
   * Extract page title
   * @private
   */
  _extractTitle($) {
    // Try multiple sources for title
    return $('title').text().trim() ||
           $('meta[property="og:title"]').attr('content')?.trim() ||
           $('h1').first().text().trim() ||
           '';
  }

  /**
   * Extract meta description
   * @private
   */
  _extractDescription($) {
    return $('meta[name="description"]').attr('content')?.trim() ||
           $('meta[property="og:description"]').attr('content')?.trim() ||
           '';
  }

  /**
   * Extract main content from page
   * Prioritizes article, main, and content areas
   * @private
   */
  _extractMainContent($) {
    // Remove unwanted elements
    $('script, style, nav, footer, header, aside, .advertisement, .ads, .sidebar, .menu, .navigation').remove();

    // Try to find main content in semantic HTML5 elements
    let content = '';
    
    // Priority order: article > main > content divs
    const selectors = [
      'article',
      'main',
      '[role="main"]',
      '.content',
      '.post',
      '.entry-content',
      '#content',
      '#main-content',
      'body'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length > 0) {
        content = element.text();
        if (content.trim().length > 200) {
          break;
        }
      }
    }

    // Clean and normalize content
    content = content
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/\n\s*\n/g, '\n') // Remove multiple newlines
      .trim();

    return content;
  }

  /**
   * Extract metadata from page
   * @private
   */
  _extractMetadata($) {
    const metadata = {
      keywords: $('meta[name="keywords"]').attr('content') || '',
      author: $('meta[name="author"]').attr('content') || 
              $('meta[property="article:author"]').attr('content') || '',
      publishedAt: $('meta[property="article:published_time"]').attr('content') || 
                   $('time[datetime]').attr('datetime') || '',
      image: $('meta[property="og:image"]').attr('content') || 
             $('meta[name="twitter:image"]').attr('content') || '',
      language: $('html').attr('lang') || 'en',
      charset: $('meta[charset]').attr('charset') || 'utf-8'
    };

    // Extract headings for structure
    const headings = [];
    $('h1, h2, h3').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.length < 200) {
        headings.push({
          level: elem.tagName.toLowerCase(),
          text: text
        });
      }
    });
    metadata.headings = headings.slice(0, 20); // Limit to 20 headings

    return metadata;
  }

  /**
   * Validate URL format
   * @private
   */
  _validateURL(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL must be a non-empty string');
    }

    try {
      const urlObj = new URL(url);
      
      // Only allow http and https
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new Error('URL must use HTTP or HTTPS protocol');
      }

      // Basic security: don't allow localhost or private IPs in production
      const hostname = urlObj.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
        throw new Error('Localhost and private IP addresses are not allowed');
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error('Invalid URL format');
      }
      throw error;
    }
  }

  /**
   * Get content statistics
   * @param {string} content - Content to analyze
   * @returns {Object} Statistics about the content
   */
  getContentStats(content) {
    if (!content) return { wordCount: 0, charCount: 0, estimatedReadTime: 0 };

    const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;
    const charCount = content.length;
    const estimatedReadTime = Math.ceil(wordCount / 200); // Average reading speed: 200 words/min

    return {
      wordCount,
      charCount,
      estimatedReadTime
    };
  }
}

// Export singleton instance (Dependency Injection ready)
module.exports = new WebScraperService();

