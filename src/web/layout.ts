/**
 * Server-rendered HTML shell for the connect page and the dashboard.
 *
 * Everything is inline (no external CSS/JS/fonts) so the pages work in
 * isolated previews and add zero third-party requests. Persian first, RTL,
 * responsive, and dark-mode aware through `prefers-color-scheme`.
 */

import { escapeHtml } from "../utils/http";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../config/constants";
import { toPersianDigits } from "../utils/time";

const BASE_CSS = `
:root{
  --bg:#0b1220; --surface:#111c2e; --surface-2:#16233a; --border:rgba(160,190,230,.16);
  --text:#eef4ff; --muted:#a9bcd6; --accent:#0fe4ba; --accent-2:#0069fa; --danger:#ef4444;
  --ok:#22c55e; --warn:#facc15; --radius:14px; --shadow:0 18px 44px rgba(0,0,0,.45);
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f3f7fc; --surface:#fff; --surface-2:#eef4fb; --border:rgba(16,36,63,.14);
    --text:#10243f; --muted:#4c6482; --shadow:0 12px 30px rgba(16,36,63,.12); }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text); min-height:100vh;
  font-family:"Vazirmatn","IRANSans","Segoe UI",system-ui,-apple-system,sans-serif;
  line-height:1.8; direction:rtl; padding:24px 16px 48px;
}
.wrap{max-width:960px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:800;font-size:1.05rem}
.bee{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#facc15,#f59e0b);
  display:grid;place-items:center;font-size:18px;color:#3b2a05}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:22px;box-shadow:var(--shadow);margin-bottom:18px}
h1,h2,h3{margin:0 0 12px;line-height:1.5}
h1{font-size:1.25rem} h2{font-size:1.05rem} h3{font-size:.95rem}
p{margin:0 0 12px;color:var(--muted)}
label{display:block;font-size:.85rem;margin:14px 0 6px;color:var(--muted);font-weight:600}
input,select,textarea{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);
  background:var(--surface-2);color:var(--text);font:inherit;font-size:.95rem}
input:focus,textarea:focus,select:focus{outline:2px solid var(--accent-2);outline-offset:1px}
button{cursor:pointer;font:inherit;border:0;border-radius:10px;padding:12px 18px;font-weight:700}
.btn{background:linear-gradient(120deg,var(--accent-2),var(--accent));color:#052;width:100%;margin-top:18px}
.btn.secondary{background:var(--surface-2);color:var(--text);border:1px solid var(--border)}
.btn.danger{background:var(--danger);color:#fff}
.btn:disabled{opacity:.6;cursor:progress}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.row>*{flex:1 1 220px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;direction:ltr;text-align:left;
  background:var(--surface-2);padding:2px 8px;border-radius:8px;display:inline-block;font-size:.85rem;word-break:break-all}
.notice{border-radius:12px;padding:12px 14px;margin:0 0 16px;font-size:.9rem;border:1px solid transparent}
.notice.error{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);color:#ffb4b4}
.notice.ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35);color:#9ae6b4}
.notice.warn{background:rgba(250,204,21,.12);border-color:rgba(250,204,21,.35);color:#fde68a}
.notice.info{background:rgba(0,105,250,.12);border-color:rgba(0,105,250,.35);color:#a8c8ff}
@media (prefers-color-scheme: light){
  .notice.error{color:#991b1b} .notice.ok{color:#166534} .notice.warn{color:#854d0e} .notice.info{color:#1e40af}
}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px}
.stat .n{font-size:1.5rem;font-weight:800;line-height:1.2}
.stat .l{font-size:.8rem;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{padding:10px 8px;text-align:right;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.78rem}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;border:1px solid var(--border)}
.pill.ok{background:rgba(34,197,94,.14);color:var(--ok)}
.pill.warn{background:rgba(250,204,21,.14);color:var(--warn)}
.pill.bad{background:rgba(239,68,68,.14);color:var(--danger)}
nav.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
nav.tabs a{padding:8px 14px;border-radius:999px;text-decoration:none;color:var(--muted);
  border:1px solid var(--border);font-size:.85rem}
nav.tabs a.active{background:var(--surface-2);color:var(--text);border-color:var(--accent-2)}
footer{margin-top:26px;text-align:center;color:var(--muted);font-size:.75rem}
.small{font-size:.8rem}
code{font-family:ui-monospace,Menlo,monospace;direction:ltr;display:inline-block}
.list{display:flex;flex-direction:column;gap:10px}
.item{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--surface-2);
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
`;

export interface LayoutOptions {
  title: string;
  body: string;
  tabs?: Array<{ href: string; label: string; active?: boolean }>;
  footerNote?: string;
}

export function layout(options: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(options.title)} · ${PRODUCT_NAME}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="bee">🐝</span><span>${PRODUCT_NAME}</span></div>
  ${options.tabs ? renderTabs(options.tabs) : ""}
  ${options.body}
  <footer>${escapeHtml(options.footerNote ?? `نسخهٔ ${PRODUCT_VERSION}`)}</footer>
</div>
</body>
</html>`;
}

function renderTabs(tabs: Array<{ href: string; label: string; active?: boolean }>): string {
  return `<nav class="tabs">${tabs
    .map((tab) => `<a href="${escapeHtml(tab.href)}" class="${tab.active ? "active" : ""}">${escapeHtml(tab.label)}</a>`)
    .join("")}</nav>`;
}

export function notice(kind: "error" | "ok" | "warn" | "info", text: string): string {
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`;
}

export function stat(label: string, value: number | string): string {
  return `<div class="stat"><div class="n">${toPersianDigits(String(value))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

export function pill(text: string, kind: "ok" | "warn" | "bad" | "none" = "none"): string {
  return `<span class="pill ${kind === "none" ? "" : kind}">${escapeHtml(text)}</span>`;
}
