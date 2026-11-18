// Supabase Edge Function: daily-expiry-alert
// ส่งสรุปสินค้าหมดอายุ / ใกล้หมดอายุ ไปที่ Telegram (ตั้งเวลาเรียกทุกเช้าด้วย pg_cron)
//
// Secrets ที่ต้องตั้ง (Dashboard > Edge Functions > Secrets):
//   TELEGRAM_BOT_TOKEN  token จาก @BotFather
//   TELEGRAM_CHAT_ID    chat id ที่จะส่ง (หลายห้องคั่นด้วย , ได้)
//   CRON_SECRET         รหัสลับยาวๆ ใช้ยืนยันว่าคำขอมาจาก cron ของเรา
//   APP_URL             (ไม่บังคับ) ลิงก์เว็บแอป จะแสดงปุ่มเปิดแอปท้ายข้อความ
//   WARN_DAYS           (ไม่บังคับ) แจ้งเตือนล่วงหน้ากี่วัน ค่าเริ่มต้น 14
//   URGENT_DAYS         (ไม่บังคับ) กลุ่ม "ด่วน" ภายในกี่วัน ค่าเริ่มต้น 3
// SUPABASE_URL และ SUPABASE_SECRET_KEYS (หรือ SUPABASE_SERVICE_ROLE_KEY แบบเก่า) ระบบใส่ให้อัตโนมัติ
//
// ไฟล์นี้ไม่มี import ภายนอก คัดลอกไปวางใน Dashboard editor ได้ทั้งไฟล์

type ExpiryLog = {
  id: string;
  barcode: string;
  qty: number;
  expDate: string;
  note?: string | null;
  status?: string | null;
};

type Product = {
  barcode: string;
  name?: string | null;
  unit?: string | null;
};

type AlertItem = {
  name: string;
  qty: number;
  unit: string;
  expDate: string;
  days: number;
  note: string;
};

export type BuildOptions = {
  todayIso: string;      // YYYY-MM-DD ตามเวลาไทย
  todayLabel: string;    // วันที่ภาษาไทยสำหรับหัวข้อ
  warnDays: number;
  urgentDays: number;
  appUrl?: string;
  maxPerSection?: number;
};

const TELEGRAM_LIMIT = 3900; // Telegram จำกัด 4096 ตัวอักษร เผื่อไว้

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function isActive(log: ExpiryLog): boolean {
  return !log.status || log.status === 'active';
}

// จำนวนวันระหว่างวันที่ 2 วัน (YYYY-MM-DD) ไม่ขึ้นกับ timezone ของเซิร์ฟเวอร์
export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = String(toIso).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function todayInTimeZone(timeZone: string, now = new Date()): { iso: string; label: string } {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const label = new Intl.DateTimeFormat('th-TH', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  return { iso, label };
}

function formatLine(item: AlertItem): string {
  let when: string;
  if (item.days < 0) when = `หมดมาแล้ว ${Math.abs(item.days)} วัน`;
  else if (item.days === 0) when = 'หมดอายุวันนี้';
  else if (item.days === 1) when = 'หมดอายุพรุ่งนี้';
  else when = `อีก ${item.days} วัน`;

  let line = `• <b>${escapeHtml(truncate(item.name, 60))}</b> — ${escapeHtml(item.qty)} ${escapeHtml(item.unit)} (${when})`;
  if (item.note) line += `\n   📍 ${escapeHtml(truncate(item.note, 50))}`;
  return line;
}

function section(title: string, items: AlertItem[], max: number): string[] {
  if (items.length === 0) return [];
  const lines = [`\n${title} <b>(${items.length})</b>`];
  items.slice(0, max).forEach(item => lines.push(formatLine(item)));
  if (items.length > max) lines.push(`   …และอีก ${items.length - max} รายการ`);
  return lines;
}

// สร้างข้อความแจ้งเตือน (แยกออกมาเพื่อทดสอบได้)
export function buildAlertMessage(logs: ExpiryLog[], products: Product[], opts: BuildOptions): { text: string; counts: Record<string, number> } {
  const max = opts.maxPerSection ?? 15;
  const byBarcode = new Map(products.map(p => [p.barcode, p]));

  const items: AlertItem[] = logs
    .filter(isActive)
    .map(log => {
      const p = byBarcode.get(log.barcode);
      return {
        name: p?.name || `ไม่ทราบชื่อสินค้า (${log.barcode})`,
        qty: Number(log.qty) || 0,
        unit: p?.unit || 'ชิ้น',
        expDate: log.expDate,
        days: daysBetween(opts.todayIso, log.expDate),
        note: (log.note || '').trim()
      };
    })
    .filter(item => Number.isFinite(item.days) && item.days <= opts.warnDays)
    .sort((a, b) => a.days - b.days);

  const expired = items.filter(i => i.days < 0);
  const urgent = items.filter(i => i.days >= 0 && i.days <= opts.urgentDays);
  const soon = items.filter(i => i.days > opts.urgentDays);
  const counts = { expired: expired.length, urgent: urgent.length, soon: soon.length };

  const lines: string[] = [`📦 <b>สรุปสินค้าหมดอายุ</b>\n🗓 ${escapeHtml(opts.todayLabel)}`];

  if (items.length === 0) {
    lines.push(`\n✅ ไม่มีสินค้าหมดอายุหรือใกล้หมดอายุภายใน ${opts.warnDays} วัน`);
  } else {
    lines.push(...section('🔴 หมดอายุแล้ว', expired, max));
    lines.push(...section(`🟠 ด่วน — ภายใน ${opts.urgentDays} วัน`, urgent, max));
    lines.push(...section(`🟡 ใกล้หมดอายุ — ภายใน ${opts.warnDays} วัน`, soon, max));
    lines.push(`\nรวม ${items.length} รายการที่ต้องจัดการ`);
  }

  if (opts.appUrl && /^https:\/\//i.test(opts.appUrl)) {
    lines.push(`\n👉 <a href="${escapeHtml(opts.appUrl)}">เปิดแอป</a>`);
  }

  // ตัดทีละบรรทัดถ้ายาวเกินข้อจำกัดของ Telegram (ไม่ตัดกลางแท็ก HTML)
  let text = '';
  for (const line of lines) {
    if ((text + '\n' + line).length > TELEGRAM_LIMIT) {
      text += '\n…(ข้อความยาวเกิน ดูรายการทั้งหมดในแอป)';
      break;
    }
    text += (text ? '\n' : '') + line;
  }
  return { text, counts };
}

// ---------- ส่วนที่รันบน Supabase ----------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function env(name: string, fallback = ''): string {
  // @ts-ignore Deno global มีเฉพาะตอนรันบน Supabase
  return (globalThis.Deno?.env.get(name) ?? fallback).trim();
}

// ใช้ secret key แบบใหม่ (SUPABASE_SECRET_KEYS) ก่อน ถ้าไม่มีค่อยใช้ service_role แบบเก่า
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

async function fetchTable<T>(baseUrl: string, key: string, table: string, select: string): Promise<T[]> {
  const headers: Record<string, string> = { apikey: key };
  // service_role แบบเก่าเป็น JWT ใช้ Authorization ได้ ส่วน sb_secret_ ใช้ apikey อย่างเดียว
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}`, { headers });
  if (!res.ok) throw new Error(`อ่านตาราง ${table} ไม่สำเร็จ: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram (${chatId}): ${data.description || res.status}`);
}

export async function handler(req: Request): Promise<Response> {
  const cronSecret = env('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const token = env('TELEGRAM_BOT_TOKEN');
  const chatIds = env('TELEGRAM_CHAT_ID').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) {
    return json({ ok: false, error: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN หรือ TELEGRAM_CHAT_ID' }, 500);
  }

  try {
    const baseUrl = env('SUPABASE_URL');
    const key = resolveServerKey();
    if (!baseUrl || !key) throw new Error('ไม่พบ SUPABASE_URL หรือ secret key ของโปรเจกต์');
    const [logs, products] = await Promise.all([
      fetchTable<ExpiryLog>(baseUrl, key, 'expiry_logs', '*'),
      fetchTable<Product>(baseUrl, key, 'master_products', 'barcode,name,unit')
    ]);

    const today = todayInTimeZone('Asia/Bangkok');
    const { text, counts } = buildAlertMessage(logs, products, {
      todayIso: today.iso,
      todayLabel: today.label,
      warnDays: Number(env('WARN_DAYS', '14')) || 14,
      urgentDays: Number(env('URGENT_DAYS', '3')) || 3,
      appUrl: env('APP_URL')
    });

    const results = await Promise.allSettled(chatIds.map(id => sendTelegram(token, id, text)));
    const errors = results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason?.message || r));
    return json({ ok: errors.length === 0, sent: chatIds.length - errors.length, counts, errors }, errors.length ? 502 : 200);
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500);
  }
}

// @ts-ignore Deno global มีเฉพาะตอนรันบน Supabase
if (globalThis.Deno?.serve) {
  // @ts-ignore
  Deno.serve(handler);
}
