/** Public landing / status page (no tenant data). */

import { layout, pill } from "./layout";
import { escapeHtml } from "../utils/http";

export function publicHealthPage(input: { version: string; botUsername: string }): string {
  const body = `
<div class="card">
  <h1>🐝 BEE.HIVE BOT</h1>
  <p>پلتفرم مدیریت و نصب خودکار پنل Bee.Hive روی حساب Cloudflare شما.</p>
  <div class="list">
    <div class="item"><span>وضعیت سرویس</span>${pill("فعال", "ok")}</div>
    <div class="item"><span>نسخه</span><span class="mono">${escapeHtml(input.version)}</span></div>
    <div class="item"><span>ربات تلگرام</span><span class="mono">${input.botUsername ? `@${escapeHtml(input.botUsername)}` : "تنظیم نشده"}</span></div>
  </div>
</div>
<div class="card">
  <h2>شروع کار</h2>
  <p>برای نصب پنل، ربات تلگرام را باز کنید، حساب Cloudflare خود را متصل کنید و دکمهٔ «ساخت پنل جدید» را بزنید.
     تمام منابع روی حساب خودتان ساخته می‌شوند.</p>
  ${input.botUsername ? `<a class="btn" style="display:block;text-align:center;text-decoration:none" href="https://t.me/${escapeHtml(input.botUsername)}">باز کردن ربات</a>` : ""}
</div>`;
  return layout({ title: "وضعیت سرویس", body });
}
