// Auth — Web Crypto only (Cloudflare Workers).
// Password: PBKDF2-SHA256, 100k iterations, 16-byte salt.
// Session: signed cookie `s=<userId>.<role>.<iat>.<sigHex>`, HMAC-SHA256(SESSION_SECRET).

const PBKDF2_ITER = 100_000;
const SESSION_TTL_SEC = 60 * 60 * 24 * 14; // 14 days
const SESSION_COOKIE = 's';
const ADMIN_FLASH_COOKIE = 'admin_flash';
const ADMIN_FLASH_TTL_SEC = 120;

function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${bytesToHex(salt)}$${bytesToHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const salt = hexToBytes(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  const got = bytesToHex(bits);
  // constant-time compare
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToHex(sig);
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(raw: string): string | null {
  try {
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4);
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export interface Session {
  userId: number;
  role: 'user' | 'admin';
  iat: number;
}

export async function signSession(secret: string, userId: number, role: 'user' | 'admin'): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const payload = `${userId}.${role}.${iat}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(secret: string, raw: string | undefined): Promise<Session | null> {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [uid, role, iat, sig] = parts;
  const payload = `${uid}.${role}.${iat}`;
  const expected = await hmac(secret, payload);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const iatN = parseInt(iat, 10);
  if (!Number.isFinite(iatN)) return null;
  if (Math.floor(Date.now() / 1000) - iatN > SESSION_TTL_SEC) return null;
  if (role !== 'user' && role !== 'admin') return null;
  const userId = parseInt(uid, 10);
  if (!Number.isFinite(userId)) return null;
  return { userId, role, iat: iatN };
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(req: Request): string | undefined {
  const cookie = req.headers.get('cookie') || '';
  for (const part of cookie.split(/;\s*/)) {
    const [k, ...rest] = part.split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

export async function signAdminFlash(secret: string, message: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_FLASH_TTL_SEC;
  const encoded = b64urlEncode(message);
  const payload = `${exp}.${encoded}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyAdminFlash(secret: string, raw: string | undefined): Promise<string | null> {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [expRaw, encoded, sig] = parts;
  const payload = `${expRaw}.${encoded}`;
  const expected = await hmac(secret, payload);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return b64urlDecode(encoded);
}

export function adminFlashCookie(value: string): string {
  return `${ADMIN_FLASH_COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_FLASH_TTL_SEC}`;
}

export function clearAdminFlashCookie(): string {
  return `${ADMIN_FLASH_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readAdminFlashCookie(req: Request): string | undefined {
  const cookie = req.headers.get('cookie') || '';
  for (const part of cookie.split(/;\s*/)) {
    const [k, ...rest] = part.split('=');
    if (k === ADMIN_FLASH_COOKIE) return rest.join('=');
  }
  return undefined;
}
