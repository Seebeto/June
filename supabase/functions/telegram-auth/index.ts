// Supabase Edge Function: telegram-auth
// ล็อกอินด้วย Telegram ID: ผู้ใช้ใส่ ID → บอทส่งรหัส 6 หลักไปใน Telegram → ใส่รหัส → ได้ session ของ Supabase Auth
//
// ใช้ secrets เดิมของโปรเจกต์: TELEGRAM_BOT_TOKEN
// SUPABASE_URL และ SUPABASE_SECRET_KEYS (หรือ SUPABASE_SERVICE_ROLE_KEY) ระบบใส่ให้อัตโนมัติ
// ⚠️ ต้องปิด "Verify JWT" ของฟังก์ชันนี้ (ผู้ใช้ยังไม่ได้ล็อกอินตอนเรียก)
//
// ไฟล์นี้ไม่มี import ภายนอก คัดลอกไปวางใน Dashboard editor ได้ทั้งไฟล์

const CODE_TTL_MINUTES = 5;        // รหัสหมดอายุใน 5 นาที
const RESEND_COOLDOWN_SECONDS = 60; // ขอรหัสใหม่ได้ทุก 60 วินาที
const MAX_CODES_PER_HOUR = 5;      // ขอรหัสได้ไม่เกิน 5 ครั้ง/ชั่วโมง/ID
const MAX_ATTEMPTS = 5;            // ใส่รหัสผิดได้ไม่เกิน 5 ครั้งต่อรหัส

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type AllowedUser = { telegram_id: number | string; name: string | null };
type LoginCode = { id: number; code_hash: string; expires_at: string; attempts: number; created_at: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function env(name: string, fallback = ''): string {
  // @ts-ignore Deno global มีเฉพาะตอนรันบน Supabase
  return (globalThis.Deno?.env.get(name) ?? fallback).trim();
}

export function resolveServerKey(): string {
  const raw = env('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, string>;
      const key = keys.default || Object.values(keys)[0];
      if (key) return String(key).trim();
    } catch (_err) {
      console.warn('อ่าน SUPABASE_SECRET_KEYS ไม่ได้ จะใช้ SUPABASE_SERVICE_ROLE_KEY แทน');
    }
  }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}

// Telegram user ID เป็นตัวเลขบวก
export function parseTelegramId(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return /^\d{4,15}$/.test(s) ? s : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// รหัส 6 หลักแบบสุ่มปลอดภัย (rejection sampling ไม่มี modulo bias)
export function generateCode(): string {
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// อีเมลภายในสำหรับ Supabase Auth (ไม่มีการส่งอีเมลจริง)
export function authEmailFor(telegramId: string): string {
  return `telegram-${telegramId}@example.com`;
}

// ---------- เรียก Supabase REST / Auth Admin ด้วย secret key ----------
class SupabaseAdmin {
  baseUrl: string;
  key: string;

  constructor(baseUrl: string, key: string) {
    this.baseUrl = baseUrl;
    this.key = key;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, 'Content-Type': 'application/json', ...extra };
    if (this.key.startsWith('eyJ')) h.Authorization = `Bearer ${this.key}`;
    return h;
  }

  async rest<T = unknown>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
      method,
      headers: this.headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`DB ${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async auth(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${this.baseUrl}/auth/v1/${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
}

async function findAllowedUser(db: SupabaseAdmin, telegramId: string): Promise<AllowedUser | null> {
  const rows = await db.rest<AllowedUser[]>('GET', `allowed_users?telegram_id=eq.${telegramId}&active=eq.true&select=telegram_id,name`);
  return rows && rows[0] ? rows[0] : null;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram: ${data.description || res.status}`);
}

// สร้างผู้ใช้ใน Supabase Auth (ครั้งแรก) แล้วออก token สำหรับเข้าสู่ระบบ
async function issueLoginToken(db: SupabaseAdmin, telegramId: string, name: string): Promise<string> {
  const email = authEmailFor(telegramId);
  const created = await db.auth('POST', 'admin/users', {
    email,
    email_confirm: true,
    app_metadata: { telegram_id: telegramId },
    user_metadata: { name }
  });
  const alreadyExists = created.status === 422 || /already|registered|exists/i.test(JSON.stringify(created.data));
  if (created.status >= 300 && !alreadyExists) {
    throw new Error(`สร้างผู้ใช้ไม่สำเร็จ: ${created.status} ${JSON.stringify(created.data)}`);
  }

  const link = await db.auth('POST', 'admin/generate_link', { type: 'magiclink', email });
  const hashed = link.data?.hashed_token ?? link.data?.properties?.hashed_token;
  if (link.status >= 300 || !hashed) {
    throw new Error(`ออก token ไม่สำเร็จ: ${link.status} ${JSON.stringify(link.data)}`);
  }
  return hashed;
}

const GENERIC_SENT = 'ถ้า Telegram ID นี้ได้รับอนุญาต รหัสจะถูกส่งไปในแชทกับบอท';
const INVALID_CODE = 'รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่';

async function handleRequestCode(db: SupabaseAdmin, botToken: string, telegramId: string): Promise<Response> {
  const user = await findAllowedUser(db, telegramId);
  if (!user) {
    // ไม่บอกว่า ID นี้ไม่มีสิทธิ์ (กันการไล่เดา ID)
    await new Promise(r => setTimeout(r, 300));
    return json({ ok: true, message: GENERIC_SENT });
  }

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db.rest<LoginCode[]>('GET',
    `login_codes?telegram_id=eq.${telegramId}&created_at=gte.${encodeURIComponent(hourAgo)}&select=created_at&order=created_at.desc`);

  if (recent.length > 0) {
    const waited = (Date.now() - Date.parse(recent[0].created_at)) / 1000;
    if (waited < RESEND_COOLDOWN_SECONDS) {
      const retryAfter = Math.ceil(RESEND_COOLDOWN_SECONDS - waited);
      return json({ ok: false, error: `กรุณารอ ${retryAfter} วินาทีแล้วขอรหัสใหม่`, retryAfter }, 429);
    }
  }
  if (recent.length >= MAX_CODES_PER_HOUR) {
    return json({ ok: false, error: 'ขอรหัสบ่อยเกินไป กรุณารอประมาณ 1 ชั่วโมงแล้วลองใหม่' }, 429);
  }

  const code = generateCode();
  await db.rest('POST', 'login_codes', {
    telegram_id: telegramId,
    code_hash: await sha256Hex(`${telegramId}:${code}`),
    expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString()
  }, 'return=minimal');

  try {
    await sendTelegram(botToken, telegramId,
      `🔐 รหัสเข้าสู่ระบบ Stock &amp; Expiry\n\n<b>${code}</b>\n\nหมดอายุใน ${CODE_TTL_MINUTES} นาที · ห้ามบอกรหัสนี้กับใคร\nถ้าคุณไม่ได้ขอรหัส ไม่ต้องทำอะไร`);
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: 'ส่งรหัสทาง Telegram ไม่ได้ — เปิดแชทกับบอทของร้านแล้วกด Start ก่อน จากนั้นลองใหม่' }, 502);
  }

  // ล้างรหัสเก่าเกิน 1 วัน
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  await db.rest('DELETE', `login_codes?created_at=lt.${encodeURIComponent(dayAgo)}`).catch(() => {});

  return json({ ok: true, message: GENERIC_SENT, cooldown: RESEND_COOLDOWN_SECONDS });
}

async function handleVerifyCode(db: SupabaseAdmin, telegramId: string, codeInput: unknown): Promise<Response> {
  const code = String(codeInput ?? '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: 'กรุณาใส่รหัส 6 หลัก' }, 400);

  const user = await findAllowedUser(db, telegramId);
  if (!user) return json({ ok: false, error: INVALID_CODE }, 401);

  const rows = await db.rest<LoginCode[]>('GET',
    `login_codes?telegram_id=eq.${telegramId}&select=id,code_hash,expires_at,attempts,created_at&order=created_at.desc&limit=1`);
  const latest = rows[0];
  if (!latest || Date.parse(latest.expires_at) < Date.now() || latest.attempts >= MAX_ATTEMPTS) {
    return json({ ok: false, error: INVALID_CODE }, 401);
  }

  const match = safeEqual(await sha256Hex(`${telegramId}:${code}`), latest.code_hash);
  if (!match) {
    const attempts = latest.attempts + 1;
    await db.rest('PATCH', `login_codes?id=eq.${latest.id}`, { attempts }, 'return=minimal');
    const left = MAX_ATTEMPTS - attempts;
    return json({ ok: false, error: left > 0 ? `รหัสไม่ถูกต้อง (ลองได้อีก ${left} ครั้ง)` : INVALID_CODE }, 401);
  }

  // ใช้รหัสได้ครั้งเดียว
  await db.rest('DELETE', `login_codes?telegram_id=eq.${telegramId}`);
  const tokenHash = await issueLoginToken(db, telegramId, user.name || '');
  return json({ ok: true, token_hash: tokenHash, name: user.name || '' });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const botToken = env('TELEGRAM_BOT_TOKEN');
  const baseUrl = env('SUPABASE_URL');
  const key = resolveServerKey();
  if (!botToken || !baseUrl || !key) {
    return json({ ok: false, error: 'ระบบยังตั้งค่าไม่ครบ (TELEGRAM_BOT_TOKEN / Supabase key)' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_err) {
    return json({ ok: false, error: 'คำขอไม่ถูกต้อง' }, 400);
  }

  const telegramId = parseTelegramId(body.telegramId);
  if (!telegramId) return json({ ok: false, error: 'Telegram ID ต้องเป็นตัวเลขเท่านั้น' }, 400);

  const db = new SupabaseAdmin(baseUrl, key);
  try {
    if (body.action === 'request') return await handleRequestCode(db, botToken, telegramId);
    if (body.action === 'verify') return await handleVerifyCode(db, telegramId, body.code);
    return json({ ok: false, error: 'action ไม่ถูกต้อง' }, 400);
  } catch (err) {
    console.error(err);
    const msg = String((err as Error)?.message || err);
    if (/allowed_users|login_codes/.test(msg) && /does not exist|42P01|PGRST205/.test(msg)) {
      return json({ ok: false, error: 'ฐานข้อมูลยังไม่ได้ตั้งค่า กรุณารัน supabase-auth-setup.sql' }, 500);
    }
    return json({ ok: false, error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' }, 500);
  }
}

// @ts-ignore Deno global มีเฉพาะตอนรันบน Supabase
if (globalThis.Deno?.serve) {
  // @ts-ignore
  Deno.serve(handler);
}
