/**
 * Renders the landing page's social cards to static PNGs:
 *   app/(marketing)/opengraph-image.png      English
 *   app/(marketing)/hi/opengraph-image.png   Hindi
 *
 * Why a real browser and not `next/og`: its renderer does not shape
 * Devanagari, so vowel signs land on the wrong letter ("बिना" came out as
 * "बनिा"). Chromium shapes it properly. Static files also mean the build
 * never has to fetch fonts.
 *
 * The text mirrors `meta.ogTitle` / `meta.ogBody` in messages/*.ts. Change
 * both together, then run: pnpm --filter @menu/web og
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CARDS = [
  {
    out: "app/(marketing)/opengraph-image.png",
    lang: "en",
    title: "Your restaurant,<br>without the noise.",
    body: "Digital menu, ordering from the table and kitchen printing.",
  },
  {
    out: "app/(marketing)/hi/opengraph-image.png",
    lang: "hi",
    title: "आपका रेस्टोरेंट,<br>बिना शोर के।",
    body: "डिजिटल मेन्यू, टेबल से ऑर्डर और किचन प्रिंटिंग।",
  },
];

const MARK = `<svg width="44" height="44" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><rect x="6.25" y="6.25" width="12.5" height="12.5" rx="3.75" fill="none" stroke="#fff" stroke-width="2.5"/><rect x="10.5" y="10.5" width="4" height="4" rx="1.25" fill="#fff"/><rect x="20.5" y="20.5" width="6" height="6" rx="2" fill="#fff"/><rect x="21" y="12" width="3.25" height="3.25" rx="1" fill="#fff" opacity=".5"/><rect x="12" y="21" width="3.25" height="3.25" rx="1" fill="#fff" opacity=".5"/></svg>`;

const page = (c) => `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600&family=Inter:wght@400&family=Noto+Sans+Devanagari:wght@400;600&display=block">
<style>
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#0c0d10;color:#f0f0f5;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;
    font-family:Inter,"Noto Sans Devanagari",sans-serif}
  .brand{display:flex;align-items:center;gap:14px;font:600 32px "Bricolage Grotesque",sans-serif;letter-spacing:-.02em}
  .brand svg{border-radius:10px;box-shadow:0 0 0 1px rgba(255,255,255,.15)}
  .brand span{color:#5f6585}
  h1{font:600 92px/1 "Bricolage Grotesque","Noto Sans Devanagari",sans-serif;letter-spacing:-.024em}
  :lang(hi) h1{font-size:84px;line-height:1.25;letter-spacing:0}
  p{margin-top:28px;font-size:30px;color:#9298b0}
  .foot{display:flex;justify-content:space-between;align-items:center;font-size:22px;color:#5f6585}
  .cta{background:#f59e0b;color:#1c1203;font-weight:600;font-family:Inter,"Noto Sans Devanagari",sans-serif;padding:12px 22px;border-radius:12px}
</style></head><body>
  <div class="brand">${MARK}<div>menu<span>.irad</span></div></div>
  <div><h1>${c.title}</h1><p>${c.body}</p></div>
  <div class="foot"><div>menu.irad.solutions</div><div class="cta">${c.lang === "hi" ? "मुफ़्त में शुरू करें" : "Start free"}</div></div>
</body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const card of CARDS) {
  await tab.setContent(page(card), { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: resolve(root, card.out) });
  console.log("wrote", card.out);
}
await browser.close();
