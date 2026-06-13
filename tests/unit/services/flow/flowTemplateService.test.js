'use strict';

const flowTemplateService = require('../../../../src/services/flow/flowTemplateService');

describe('flowTemplateService.render', () => {
  const interaction = {
    platform: 'whatsapp',
    content: 'I want the price',
    author: { name: 'Sam Lee', username: 'samlee' }
  };

  it('interpolates built-in author tokens', () => {
    expect(flowTemplateService.render('Hi {{username}}!', { interaction }))
      .toBe('Hi samlee!');
    expect(flowTemplateService.render('Hello {{name}}', { interaction }))
      .toBe('Hello Sam Lee');
    expect(flowTemplateService.render('Hey {{first_name}}', { interaction }))
      .toBe('Hey Sam');
  });

  it('interpolates the inbound message content', () => {
    expect(flowTemplateService.render('You said: {{content}}', { interaction }))
      .toBe('You said: I want the price');
  });

  it('interpolates enrollment variables and lets them override built-ins', () => {
    const variables = { username: 'VIP', orderRef: 'ORD-2847' };
    expect(flowTemplateService.render('Ref {{orderRef}} for {{username}}', { interaction, variables }))
      .toBe('Ref ORD-2847 for VIP');
  });

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(flowTemplateService.render('{{ USERNAME }}', { interaction }))
      .toBe('samlee');
  });

  it('replaces unknown tokens with an empty string (never leaks raw placeholders)', () => {
    expect(flowTemplateService.render('Hi {{missing}}!', { interaction }))
      .toBe('Hi !');
  });

  it('JSON-encodes object variables', () => {
    const variables = { extracted: { budget: '500' } };
    expect(flowTemplateService.render('{{extracted}}', { interaction, variables }))
      .toBe('{"budget":"500"}');
  });

  it('returns non-string and placeholder-free input unchanged', () => {
    expect(flowTemplateService.render(42)).toBe(42);
    expect(flowTemplateService.render('no tokens here', { interaction }))
      .toBe('no tokens here');
  });

  it('renderConfig interpolates only the requested string keys', () => {
    const out = flowTemplateService.renderConfig(
      { bodyText: 'Hi {{name}}', mediaUrl: 'https://x/y.jpg', count: 3 },
      ['bodyText', 'mediaUrl'],
      { interaction }
    );
    expect(out.bodyText).toBe('Hi Sam Lee');
    expect(out.mediaUrl).toBe('https://x/y.jpg');
    expect(out.count).toBe(3);
  });
});
