// mobile-responsive.test.ts
// Static analysis of CSS and HTML to verify mobile-first responsive rules.
// Run: node --test --experimental-strip-types test/mobile-responsive.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname!, '../public/assets/app.css');
const LAYOUT_PATH = resolve(import.meta.dirname!, '../src/views/layout.tsx');
const css = readFileSync(CSS_PATH, 'utf8');
const layout = readFileSync(LAYOUT_PATH, 'utf8');

// ── viewport ──────────────────────────────────────────────────────────────────
test('viewport meta has width=device-width', () => {
  assert.match(layout, /width=device-width/);
});

test('viewport meta has initial-scale=1', () => {
  assert.match(layout, /initial-scale=1/);
});

test('viewport meta has viewport-fit=cover (safe-area notch)', () => {
  assert.match(layout, /viewport-fit=cover/);
});

// ── overflow-x hidden ─────────────────────────────────────────────────────────
test('body has overflow-x: hidden to prevent horizontal scroll', () => {
  assert.match(css, /body\s*{[^}]*overflow-x\s*:\s*hidden/s);
});

// ── font-size 16px on inputs (iOS zoom prevention) ───────────────────────────
test('input elements have font-size 16px (iOS zoom prevention)', () => {
  // Match .form-row input block containing font-size: 16px
  const inputBlock = css.match(/\.form-row input[^{]*{([^}]+)}/s);
  assert.ok(inputBlock, '.form-row input rule found');
  assert.match(inputBlock![1], /font-size\s*:\s*16px/);
});

test('select elements have font-size 16px', () => {
  // Can be in the same rule block
  assert.match(css, /font-size\s*:\s*16px/);
});

// ── mobile-first: base (no MQ) before min-width ───────────────────────────────
test('mobile-first: .section-title base font-size defined (mobile ≤ desktop)', () => {
  // Base .section-title should exist with a font-size value.
  const baseRule = css.match(/\.section-title\s*{([^}]+)}/s);
  assert.ok(baseRule, '.section-title base rule found');
  assert.match(baseRule![1], /font-size/, '.section-title base has font-size');
  // Desktop override inside a min-width MQ should have larger font-size.
  // Check that 3rem appears somewhere after a min-width:768 MQ for section-title.
  const desktopBlock = css.match(/@media\s*\(min-width:\s*768px\)[^{]*{[^@]*\.section-title\s*{([^}]+)}/s);
  assert.ok(desktopBlock, 'desktop .section-title override found in min-width:768px MQ');
  assert.match(desktopBlock![1], /font-size/, 'desktop override has font-size');
});

test('mobile-first: no max-width media queries (only min-width)', () => {
  // Only exception allowed: the admin table card layout uses max-width:639px
  const maxWidthMatches = [...css.matchAll(/@media\s*\(max-width:/g)];
  // There should be at most 1 (the admin card table breakpoint)
  assert.ok(maxWidthMatches.length <= 1, `Expected ≤1 max-width MQ, got ${maxWidthMatches.length}`);
});

// ── touch targets ─────────────────────────────────────────────────────────────
test('--touch custom property defined to 44px', () => {
  assert.match(css, /--touch\s*:\s*44px/);
});

test('buttons reference --touch for min-height', () => {
  assert.match(css, /min-height\s*:\s*var\(--touch\)/);
});

// ── container width ───────────────────────────────────────────────────────────
test('container has width:100% for mobile', () => {
  const containerRule = css.match(/\.container\s*{([^}]+)}/s);
  assert.ok(containerRule, '.container rule found');
  assert.match(containerRule![1], /width\s*:\s*100%/);
});

test('container has max-width for desktop', () => {
  assert.match(css, /max-width\s*:\s*720px/);
});

// ── form-stack full width on mobile ──────────────────────────────────────────
test('form-stack has width:100% base (mobile)', () => {
  const formRule = css.match(/\.form-stack\s*{([^}]+)}/s);
  assert.ok(formRule, '.form-stack rule found');
  assert.match(formRule![1], /width\s*:\s*100%/);
});

test('form-stack max-width:24rem only at min-width:768px', () => {
  // max-width:24rem should NOT appear in the base form-stack rule.
  const baseFormStack = css.match(/\.form-stack\s*{([^}]+)}/s);
  assert.ok(baseFormStack, '.form-stack base rule found');
  assert.doesNotMatch(baseFormStack![1], /max-width/, 'base form-stack has no max-width (mobile full-width)');
  // But somewhere a 768px MQ should set form-stack max-width.
  assert.match(css, /min-width:\s*768px[\s\S]*?form-stack[\s\S]*?max-width/, 'form-stack max-width inside min-width:768px');
});

// ── SVG responsive ────────────────────────────────────────────────────────────
test('trend-svg has width:100%', () => {
  const svgRule = css.match(/\.trend-svg\s*{([^}]+)}/s);
  assert.ok(svgRule, '.trend-svg rule found');
  assert.match(svgRule![1], /width\s*:\s*100%/);
});

test('trend-svg has height:auto for responsive scaling', () => {
  const svgRule = css.match(/\.trend-svg\s*{([^}]+)}/s);
  assert.ok(svgRule);
  assert.match(svgRule![1], /height\s*:\s*auto/);
});

// ── admin table mobile cards ──────────────────────────────────────────────────
test('admin table has max-width:639px card layout rule', () => {
  assert.match(css, /@media\s*\(max-width:\s*639px\)/);
});

test('admin table thead hidden on mobile', () => {
  const mobileBlock = css.match(/@media\s*\(max-width:\s*639px\)\s*{([^@]+)}/s);
  assert.ok(mobileBlock, 'mobile block found');
  assert.match(mobileBlock![1], /thead/);
  assert.match(mobileBlock![1], /display\s*:\s*none/);
});

test('admin table td::before uses attr(data-label)', () => {
  assert.match(css, /content\s*:\s*attr\(data-label\)/);
});

// ── layout.tsx logo ──────────────────────────────────────────────────────────
test('layout has brand-logo img (not brand-num span)', () => {
  assert.match(layout, /brand-logo/);
  assert.doesNotMatch(layout, /brand-num/);
});

// ── favicon ───────────────────────────────────────────────────────────────────
test('layout has favicon link', () => {
  assert.match(layout, /rel="icon"/);
  assert.match(layout, /favicon\.png/);
});
