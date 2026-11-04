import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/index.tsx'), 'utf8');

test('HTTP redirects to the same URL with HTTPS', () => {
  assert.match(source, /url\.protocol === 'http:'/);
  assert.match(source, /url\.protocol = 'https:'/);
  assert.match(source, /c\.redirect\(url\.toString\(\), 308\)/);
});

test('app responses carry baseline security headers', () => {
  assert.match(source, /Strict-Transport-Security', 'max-age=86400'/);
  assert.match(source, /X-Content-Type-Options', 'nosniff'/);
  assert.match(source, /Referrer-Policy', 'strict-origin-when-cross-origin'/);
  assert.match(source, /X-Frame-Options', 'SAMEORIGIN'/);
});
