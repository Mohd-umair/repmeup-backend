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
    this.crawlDelayMs = 400; // politeness delay between page fetches during a crawl
  }

  /**
   * Scrape a URL and extract structured content
   * @param {string} url - The URL to scrape
   * @param {Object} [opts]
   * @param {boolean} [opts.extractLinks=false] - Also return same-origin internal links (for crawling)
   * @returns {Promise<Object>} Scraped content with metadata
   */
  async scrape(url, opts = {}) {
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

      // Only parse HTML responses — skip binary/asset bodies that slipped through.
      const contentType = String(response.headers['content-type'] || '');
      if (contentType && !contentType.includes('html')) {
        throw new Error('URL did not return an HTML document.');
      }

      // Parse HTML. Links are extracted BEFORE _extractMainContent strips <nav>/<footer>,
      // since those regions usually hold the site's primary navigation links.
      const $ = cheerio.load(response.data);
      const links = opts.extractLinks ? this._extractInternalLinks($, url) : [];

      // Extract structured content — fall back to meta tags for SPA / JS-rendered pages.
      let mainContent = this._extractMainContent($);
      let isSpaFallback = false;

      if (!mainContent || mainContent.trim().length < 50) {
        const metaContent = this._extractMetaContent($);
        if (metaContent) {
          mainContent = metaContent;
          isSpaFallback = true;
        }
      }

      // Extract structured content
      const scrapedData = {
        url: url,
        title: this._extractTitle($),
        description: this._extractDescription($),
        content: mainContent,
        metadata: { ...this._extractMetadata($), isSpaFallback },
        links,
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
   * Build a meaningful text block from <head> meta tags alone.
   * Used as a fallback when _extractMainContent yields nothing — most
   * commonly because the page is a JavaScript SPA (React, Angular, Vue, Next.js)
   * that renders all its visible content at runtime.
   *
   * Returns an empty string when there are not enough meta tags to build
   * anything useful (< 30 chars total), so the caller can still decide to
   * throw a proper error rather than save a useless entry.
   * @private
   */
  _extractMetaContent($) {
    const parts = [];

    const title = this._extractTitle($);
    if (title) parts.push(title);

    // Description — try several sources in priority order.
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      $('meta[name="twitter:description"]').attr('content')?.trim() || '';
    if (description && description !== title) parts.push(description);

    const keywords = $('meta[name="keywords"]').attr('content')?.trim();
    if (keywords) parts.push(`Keywords: ${keywords}`);

    const siteName = $('meta[property="og:site_name"]').attr('content')?.trim();
    if (siteName && siteName !== title) parts.push(siteName);

    // Collect any remaining <meta name="…"> content tags that look like
    // human-readable text (not directives, tokens or numeric values).
    $('meta[name]').each((_, el) => {
      const name = $(el).attr('name')?.toLowerCase() || '';
      // Skip already-covered or machine-only tags.
      if (['description', 'keywords', 'author', 'viewport', 'robots', 'theme-color',
           'google-site-verification', 'charset', 'generator', 'application-name'].includes(name)) return;
      const content = $(el).attr('content')?.trim();
      if (content && content.length > 20 && content.length < 500 && !/^[\d./,\-+%]+$/.test(content)) {
        parts.push(content);
      }
    });

    const raw = parts.join(' | ');
    return raw.trim().length >= 30 ? raw.trim() : '';
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

  // ──────────────────────────────────────────────────────────────────────────
  // Whole-site crawling
  // ──────────────────────────────────────────────────────────────────────────

  /** File extensions we never want to crawl (binary assets, not readable pages). */
  static get SKIP_EXTENSIONS() {
    return [
      '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico',
      '.mp4', '.webm', '.mp3', '.wav', '.avi', '.mov',
      '.zip', '.rar', '.gz', '.tar', '.7z',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.css', '.js', '.json', '.xml', '.rss', '.woff', '.woff2', '.ttf', '.eot'
    ];
  }

  /**
   * Normalize a URL for de-duplication during a crawl:
   * - drop hash fragments and query strings (treat /page and /page?x=1 as same page)
   * - strip a trailing slash
   * - lowercase the host
   * Returns null when the URL can't be parsed.
   * @private
   */
  _normalizeUrl(rawUrl, baseUrl) {
    try {
      const u = new URL(rawUrl, baseUrl);
      u.hash = '';
      u.search = '';
      u.hostname = u.hostname.toLowerCase();
      let out = u.toString();
      if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
      return out;
    } catch (_) {
      return null;
    }
  }

  /**
   * True when `candidate` belongs to the same registrable site as `origin`.
   * Treats `www.` and the bare host as the same origin so we don't miss pages.
   * @private
   */
  _isSameSite(candidateUrl, originUrl) {
    try {
      const c = new URL(candidateUrl);
      const o = new URL(originUrl);
      const strip = (h) => h.toLowerCase().replace(/^www\./, '');
      return strip(c.hostname) === strip(o.hostname);
    } catch (_) {
      return false;
    }
  }

  /**
   * Extract de-duplicated, same-site, crawlable internal links from a page.
   * @private
   */
  _extractInternalLinks($, pageUrl) {
    const found = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const trimmed = href.trim();
      // Skip non-navigational links early.
      if (!trimmed || trimmed.startsWith('#') ||
          trimmed.startsWith('mailto:') || trimmed.startsWith('tel:') ||
          trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) {
        return;
      }
      const normalized = this._normalizeUrl(trimmed, pageUrl);
      if (!normalized) return;
      if (!this._isSameSite(normalized, pageUrl)) return;
      // Skip binary assets by extension.
      const path = (() => { try { return new URL(normalized).pathname.toLowerCase(); } catch { return ''; } })();
      if (WebScraperService.SKIP_EXTENSIONS.some(ext => path.endsWith(ext))) return;
      found.add(normalized);
    });
    return Array.from(found);
  }

  /**
   * Fetch a page and return ONLY its same-site internal links, ignoring content.
   * Used as a recovery path for content-light start pages so a crawl can still
   * proceed to the site's internal (content-rich) pages.
   * @private
   */
  async _extractLinksOnly(url) {
    const response = await axios.get(url, {
      headers: { 'User-Agent': this.userAgent, 'Accept': 'text/html,application/xhtml+xml' },
      timeout: this.defaultTimeout,
      maxContentLength: this.maxContentLength,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });
    const contentType = String(response.headers['content-type'] || '');
    if (contentType && !contentType.includes('html')) return [];
    const $ = cheerio.load(response.data);
    return this._extractInternalLinks($, url);
  }

  /**
   * Fetch a page and return its title + same-site internal links (no content extraction).
   * Used for the URL-discovery step before the user picks pages to import.
   * @private
   */
  async _fetchPageMeta(url) {
    this._validateURL(url);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: this.defaultTimeout,
      maxContentLength: this.maxContentLength,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const contentType = String(response.headers['content-type'] || '');
    if (contentType && !contentType.includes('html')) {
      return { url, title: url, links: [] };
    }

    const $ = cheerio.load(response.data);
    return {
      url,
      title: this._extractTitle($) || url,
      links: this._extractInternalLinks($, url),
      isSpa: false
    };
  }

  /**
   * Discover internal same-site URLs without scraping full page content.
   * Returns metadata the UI can show in a checkbox list.
   *
   * @param {string} startUrl
   * @param {Object} [options]
   * @param {number} [options.maxPages=25]
   * @param {number} [options.maxDepth=3]
   * @returns {Promise<{ urls: Array<{url:string,title:string,depth:number}>, startUrl: string, totalFound: number }>}
   */
  async discoverInternalUrls(startUrl, options = {}) {
    const maxPages = Math.max(1, Math.min(options.maxPages || 25, 100));
    const maxDepth = Math.max(0, options.maxDepth ?? 3);

    this._validateURL(startUrl);
    const normalizedStart = this._normalizeUrl(startUrl, startUrl) || startUrl;

    const visited = new Set();
    const queued = new Set([normalizedStart]);
    const queue = [{ url: normalizedStart, depth: 0 }];
    const discovered = [];
    let fetched = false;

    while (queue.length > 0 && discovered.length < maxPages) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      if (fetched && this.crawlDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.crawlDelayMs));
      }

      let meta;
      try {
        meta = await this._fetchPageMeta(url);
      } catch (err) {
        if (!fetched && url === normalizedStart) {
          throw new Error(`Failed to discover pages: ${err.message}`);
        }
        continue;
      }
      fetched = true;

      discovered.push({
        url: this._normalizeUrl(meta.url, normalizedStart) || meta.url,
        title: (meta.title || meta.url).slice(0, 300),
        depth
      });

      if (depth < maxDepth) {
        for (const link of meta.links || []) {
          if (queued.size >= maxPages * 4) break;
          if (!visited.has(link) && !queued.has(link)) {
            queued.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    }

    if (discovered.length === 0) {
      throw new Error('No pages found on this website.');
    }

    return { urls: discovered, startUrl: normalizedStart, totalFound: discovered.length };
  }

  /**
   * Normalize and keep only same-site URLs (for user-selected import lists).
   */
  filterSameSiteUrls(startUrl, urls = []) {
    if (!Array.isArray(urls)) return [];
    const out = new Set();
    for (const raw of urls) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const normalized = this._normalizeUrl(raw.trim(), startUrl);
      if (normalized && this._isSameSite(normalized, startUrl)) {
        out.add(normalized);
      }
    }
    return Array.from(out);
  }

  /**
   * Crawl a website starting from `startUrl`, breadth-first, same-site only.
   * Returns successfully-scraped pages (each is a full scrape() result).
   *
   * Robust by design: a single page failing (timeout, 404, non-HTML) is skipped,
   * not fatal — the crawl continues. The start page failing IS fatal.
   *
   * @param {string} startUrl
   * @param {Object} [options]
   * @param {number} [options.maxPages=25] - Hard cap on pages scraped.
   * @param {number} [options.maxDepth=3]  - Link-distance from the start page.
   * @param {function} [options.onProgress] - async ({ pagesFound, pagesProcessed, currentUrl }) => void
   * @returns {Promise<{ pages: Object[], visited: number, startUrl: string }>}
   */
  async crawlSite(startUrl, options = {}) {
    const maxPages = Math.max(1, Math.min(options.maxPages || 25, 100));
    const maxDepth = Math.max(0, options.maxDepth ?? 3);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    this._validateURL(startUrl);
    const normalizedStart = this._normalizeUrl(startUrl, startUrl) || startUrl;

    const visited = new Set();
    const queued = new Set([normalizedStart]);
    const queue = [{ url: normalizedStart, depth: 0 }];
    const pages = [];
    let startScraped = false;

    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth } = queue.shift();
      visited.add(url);

      // Politeness delay between fetches (skip before the very first page).
      if (startScraped && this.crawlDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.crawlDelayMs));
      }

      let data;
      try {
        // Only extract links while we still have room/depth to follow them.
        const needLinks = depth < maxDepth && pages.length + 1 < maxPages;
        data = await this.scrape(url, { extractLinks: needLinks });
      } catch (err) {
        // Start page recovery: many homepages are text-light but link-rich
        // (hero images, JS widgets). Rather than abort the whole crawl, try a
        // links-only fetch so we can still reach the site's internal pages.
        if (!startScraped && url === normalizedStart) {
          try {
            const links = await this._extractLinksOnly(url);
            startScraped = true;
            if (links.length === 0) {
              throw new Error(`Failed to crawl start page: ${err.message}`);
            }
            for (const link of links) {
              if (queued.size >= maxPages * 4) break;
              if (!visited.has(link) && !queued.has(link)) {
                queued.add(link);
                queue.push({ url: link, depth: 1 });
              }
            }
            continue; // start page itself yields no KB entry, but its links proceed
          } catch (inner) {
            throw new Error(`Failed to crawl start page: ${inner.message}`);
          }
        }
        // Deeper pages are best-effort — skip and continue.
        continue;
      }

      startScraped = true;
      pages.push(data);

      if (onProgress) {
        try {
          await onProgress({ pagesFound: queued.size, pagesProcessed: pages.length, currentUrl: url });
        } catch (_) { /* progress reporting must never break the crawl */ }
      }

      // Enqueue freshly-discovered links (breadth-first).
      if (depth < maxDepth && Array.isArray(data.links)) {
        for (const link of data.links) {
          if (queued.size >= maxPages * 4) break; // bound the frontier
          if (!visited.has(link) && !queued.has(link)) {
            queued.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    }

    if (pages.length === 0) {
      throw new Error('No readable pages found while crawling the website.');
    }

    return { pages, visited: visited.size, startUrl: normalizedStart };
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

