/**
 * Test script to verify AI summarization is working
 * Run: node test-summarization.js
 */

require('dotenv').config();
const webScraperService = require('./src/services/webScraperService');
const contentSummarizerService = require('./src/services/contentSummarizerService');

async function testSummarization() {
  try {
    const testUrl = 'https://example.com';
    
    console.log('🧪 Testing Web Scraper Service...');
    const scrapedData = await webScraperService.scrape(testUrl);
    console.log(`✅ Scraped content: ${scrapedData.content.length} characters`);
    console.log(`   Title: ${scrapedData.title}`);
    
    console.log('\n🧪 Testing AI Summarization Service...');
    const summaryData = await contentSummarizerService.summarize(
      scrapedData.content,
      {
        title: scrapedData.title,
        url: testUrl,
        focus: 'overview'
      }
    );
    
    console.log(`✅ Summary generated: ${summaryData.summaryLength} characters`);
    console.log(`   Compression: ${summaryData.compressionRatio}`);
    console.log(`   Key Points: ${summaryData.keyPoints.length}`);
    console.log(`   Tags: ${summaryData.tags.length}`);
    console.log('\n📄 Summary Preview:');
    console.log(summaryData.summary.substring(0, 200) + '...');
    
    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testSummarization();

