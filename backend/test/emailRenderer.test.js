const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeContextFromContact, applyMergeTags, renderBlocksToHtml, renderBlocksToText, extractLinks, withTrackedLinks
} = require('../lib/emailRenderer');

test('mergeContextFromContact() splits display_name into first/last and carries email/phone', () => {
  const ctx = mergeContextFromContact({ display_name: 'Jane Doe', email: 'jane@x.com', phone: '91999' });
  assert.equal(ctx.firstName, 'Jane');
  assert.equal(ctx.lastName, 'Doe');
  assert.equal(ctx.email, 'jane@x.com');
});

test('mergeContextFromContact() handles a single-word or missing name gracefully', () => {
  assert.equal(mergeContextFromContact({ display_name: 'Cher' }).lastName, '');
  assert.equal(mergeContextFromContact({}).firstName, '');
  assert.equal(mergeContextFromContact(null).firstName, '');
});

test('applyMergeTags() substitutes a known field', () => {
  assert.equal(applyMergeTags('Hi {{firstName}}!', { firstName: 'Jane' }), 'Hi Jane!');
});

test('applyMergeTags() uses the fallback when the field is empty or unknown', () => {
  assert.equal(applyMergeTags('Hi {{firstName|there}}!', { firstName: '' }), 'Hi there!');
  assert.equal(applyMergeTags('Hi {{unknownField|friend}}!', {}), 'Hi friend!');
});

test('applyMergeTags() leaves no literal tag when there is no fallback and no value', () => {
  assert.equal(applyMergeTags('Hi {{firstName}}!', {}), 'Hi !');
});

test('applyMergeTags() handles multiple tags in one string', () => {
  assert.equal(applyMergeTags('{{firstName}} {{lastName}}', { firstName: 'Jane', lastName: 'Doe' }), 'Jane Doe');
});

test('renderBlocksToHtml() escapes merge-tag values to prevent HTML injection from contact data', () => {
  const html = renderBlocksToHtml([{ type: 'text', text: '{{firstName}}' }], { context: { firstName: '<script>alert(1)</script>' } });
  assert.ok(!html.includes('<script>'), 'expected the script tag to be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderBlocksToHtml() renders a heading, text, button and divider', () => {
  const html = renderBlocksToHtml([
    { type: 'heading', text: 'Hello {{firstName}}' },
    { type: 'text', text: 'Body text' },
    { type: 'button', label: 'Shop now', href: 'https://example.com' },
    { type: 'divider' }
  ], { context: { firstName: 'Jane' } });
  assert.ok(html.includes('Hello Jane'));
  assert.ok(html.includes('Body text'));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes('Shop now'));
  assert.ok(html.includes('<hr'));
});

test('renderBlocksToText() produces a readable plain-text fallback with merge tags applied', () => {
  const text = renderBlocksToText([
    { type: 'heading', text: 'hello' },
    { type: 'text', text: 'Hi {{firstName}}' },
    { type: 'button', label: 'Shop', href: 'https://example.com' }
  ], { context: { firstName: 'Jane' } });
  assert.ok(text.includes('HELLO'));
  assert.ok(text.includes('Hi Jane'));
  assert.ok(text.includes('https://example.com'));
});

test('extractLinks() collects every button href and ignores other block types', () => {
  const links = extractLinks([
    { type: 'button', href: 'https://a.com' },
    { type: 'text', text: 'not a link' },
    { type: 'button', href: 'https://b.com' }
  ]);
  assert.deepEqual(links, ['https://a.com', 'https://b.com']);
});

test('withTrackedLinks() rewrites only button hrefs, leaving other blocks untouched', () => {
  const blocks = [{ type: 'button', href: 'https://a.com', label: 'Go' }, { type: 'text', text: 'hi' }];
  const tracked = withTrackedLinks(blocks, (url) => `https://track.example.com/?u=${encodeURIComponent(url)}`);
  assert.equal(tracked[0].href, 'https://track.example.com/?u=https%3A%2F%2Fa.com');
  assert.equal(tracked[0].label, 'Go');
  assert.equal(tracked[1].text, 'hi');
});
