// settings.test.ts
// Static analysis: settings view HTML structure + route coverage in index.tsx.
// Run: node --test --experimental-strip-types test/settings.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SETTINGS_VIEW = resolve(import.meta.dirname!, '../src/views/settings.tsx');
const LAYOUT_VIEW   = resolve(import.meta.dirname!, '../src/views/layout.tsx');
const AUTH_VIEW     = resolve(import.meta.dirname!, '../src/views/auth.tsx');
const INDEX         = resolve(import.meta.dirname!, '../src/index.tsx');
const CSS           = resolve(import.meta.dirname!, '../public/assets/app.css');

const sv  = readFileSync(SETTINGS_VIEW, 'utf8');
const lv  = readFileSync(LAYOUT_VIEW,   'utf8');
const av  = readFileSync(AUTH_VIEW,     'utf8');
const idx = readFileSync(INDEX,         'utf8');
const css = readFileSync(CSS,           'utf8');

// ── Settings view structure ───────────────────────────────────────────────────
test('settings view has 3 sections: profile, password, session', () => {
  assert.match(sv, /01 · profile/);
  assert.match(sv, /02 · password/);
  assert.match(sv, /03 · session/);
});

test('settings view profile form POSTs to /settings/profile', () => {
  assert.match(sv, /action="\/settings\/profile"/);
});

test('settings view password form POSTs to /settings/password', () => {
  assert.match(sv, /action="\/settings\/password"/);
});

test('settings view has current_password, new_password, confirm_password fields', () => {
  assert.match(sv, /name="current_password"/);
  assert.match(sv, /name="new_password"/);
  assert.match(sv, /name="confirm_password"/);
});

test('settings view has birthday, gender, height_cm profile fields', () => {
  assert.match(sv, /name="birthday"/);
  assert.match(sv, /name="gender"/);
  assert.match(sv, /name="height_cm"/);
});

test('settings view shows admin-no-profile message when role=admin', () => {
  assert.match(sv, /admin.*no profile\b|Admin accounts don.*t have profile/i);
});

test('settings view has logout form', () => {
  assert.match(sv, /action="\/logout"/);
});

test('password update success message mentions sign in (in index route map)', () => {
  // The success message is defined in the index.tsx SUCCESS_MSGS map.
  assert.match(idx, /sign in again|Please sign in/i);
});

// ── Layout: username link ─────────────────────────────────────────────────────
test('layout nav-user is now a link to /settings (not a plain span)', () => {
  assert.match(lv, /href="\/settings"/);
  assert.doesNotMatch(lv, /<span class="nav-user">/);
});

test('layout active type includes settings', () => {
  assert.match(lv, /settings/);
});

// ── nav-user CSS: clickable with hover style ──────────────────────────────────
test('CSS has hover/active style for .nav-user', () => {
  assert.match(css, /\.nav-user\s*{[^}]*display\s*:\s*inline-flex/s);
});

// ── Index: routes ────────────────────────────────────────────────────────────
test('index has GET /settings route', () => {
  assert.match(idx, /app\.get\(['"]\/settings['"]/);
});

test('index has POST /settings/profile route', () => {
  assert.match(idx, /app\.post\(['"]\/settings\/profile['"]/);
});

test('index has POST /settings/password route', () => {
  assert.match(idx, /app\.post\(['"]\/settings\/password['"]/);
});

test('index has requireLoggedIn middleware (both roles)', () => {
  assert.match(idx, /requireLoggedIn/);
  // requireLoggedIn should NOT check for role === user only
  const fnBody = idx.match(/requireLoggedIn[^}]*}/s)?.[0] ?? '';
  assert.doesNotMatch(fnBody, /role !== 'user'/);
});

test('index settings/password clears session cookie (forces re-login)', () => {
  assert.match(idx, /clearSessionCookie/);
  // clearSessionCookie should be used in the password route context
  assert.match(idx, /settings\/password[\s\S]*?clearSessionCookie/);
});

test('index password route checks current_password with verifyPassword', () => {
  assert.match(idx, /verifyPassword\(current/);
});

test('index password route validates new_password length >= 8', () => {
  assert.match(idx, /next\.length < 8|new_password.*length|minlength.*8/);
});

test('index password route checks new === confirm', () => {
  assert.match(idx, /next !== confirm/);
});

test('index profile route blocks admin role', () => {
  assert.match(idx, /role.*admin.*admin_no_profile|admin.*no_profile/);
});

// ── Admin reset: notice updated to mention /settings ─────────────────────────
test('admin reset password notice mentions /settings', () => {
  assert.match(idx, /signAdminFlash[\s\S]*Temp password[\s\S]*settings/i);
  assert.doesNotMatch(idx, /redirect\(`\/admin\?ok=\$\{encodeURIComponent\('Temp password/);
});

// ── Login page: notice for password change ────────────────────────────────────
test('LoginView accepts notice prop', () => {
  assert.match(av, /notice\?:/);
});

test('login page shows notice when ok=pw_changed', () => {
  assert.match(idx, /pw_changed/);
});
