// Image capture for Tools for Conviviality.
//
// For each tool in data/tools.json this visits the tool's public page and collects:
//   - screenshots (desktop and phone), resized to a few widths
//   - the best icon it can find (SVG is kept as SVG, so it scales cleanly)
//   - the social preview image (og:image), if the maker published one
//   - the maker's theme colour, or a dominant colour taken from the icon
// and writes a manifest the site reads, with the source and capture date of everything.
//
// Manners: it identifies itself, obeys robots.txt, goes one tool at a time with a pause
// between them, and skips any tool whose entry says "images": false (a maker's opt-out).
//
// Usage:
//   node scripts/capture.mjs                      capture anything missing or older than 30 days
//   node scripts/capture.mjs --only comaps        one tool
//   node scripts/capture.mjs --force              recapture everything
//   node scripts/capture.mjs --data x.json --out some/dir    (used by the local test)

import { chromium } from "playwright";
import sharp from "sharp";
import robotsParser from "robots-parser";
import fs from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1] ?? true;
};
const DATA = opt("data", "data/tools.json");
const OUT = opt("out", "assets");
const ONLY = opt("only", null);
const FORCE = argv.includes("--force");
const MAX_AGE_DAYS = Number(opt("max-age", 30));
const PAUSE_MS = Number(opt("pause", 2000));

const UA = "ToolsForConvivialityBot/1.0 (+https://toolsforconviviality.org/#about; hello@toolsforconviviality.org)";
const TOOLS_DIR = path.join(OUT, "tools");
const MANIFEST = path.join(OUT, "manifest.json");
const toSitePath = (p) => p.split(path.sep).join("/");

const SHOT_WIDTHS = [480, 960, 1600];
const ICON_WIDTHS = [128, 256];
const CONSENT_SELECTORS = [
  'button:has-text("Reject all")', 'button:has-text("Reject All")', 'button:has-text("Decline")',
  'button:has-text("Only necessary")', 'button:has-text("Necessary only")', 'button:has-text("Refuse")',
  'button:has-text("No thanks")', 'button:has-text("Got it")', 'button:has-text("Dismiss")', 'button:has-text("Close")'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const exists = (p) => fs.access(p).then(() => true, () => false);
const readJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } };

const robotsCache = new Map();
async function allowedByRobots(url) {
  const { origin } = new URL(url);
  if (!robotsCache.has(origin)) {
    let parser = null;
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
      if (res.ok) parser = robotsParser(`${origin}/robots.txt`, await res.text());
    } catch { /* unreachable robots.txt counts as no rules */ }
    robotsCache.set(origin, parser);
  }
  const parser = robotsCache.get(origin);
  return parser ? parser.isAllowed(url, "ToolsForConvivialityBot") !== false : true;
}

async function download(url, maxBytes) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`too large (${buf.length} bytes): ${url}`);
  return { buf, type: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
}

const parseSizes = (s) => {
  if (!s) return 0;
  let best = 0;
  for (const part of s.split(/\s+/)) {
    const m = part.match(/^(\d+)x(\d+)$/i);
    if (m) best = Math.max(best, Number(m[1]));
  }
  return best;
};

function pickIcon(candidates) {
  const scored = candidates.map((c) => {
    const isSvg = c.type === "image/svg+xml" || /\.svg(\?|$)/i.test(c.href) || /^any$/i.test(c.sizes || "");
    const isIco = c.type === "image/x-icon" || /\.ico(\?|$)/i.test(c.href);
    if (isIco) return { ...c, score: -1 };
    let score = isSvg ? 10000 : parseSizes(c.sizes) || (c.kind === "apple" ? 180 : 32);
    if (c.kind === "apple") score += 5;
    return { ...c, isSvg, score };
  }).filter((c) => c.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

const hex = (n) => n.toString(16).padStart(2, "0");
const validColor = (c) => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim().toLowerCase() : null);

async function saveVariants(buf, dir, prefix, widths, { quality = 82 } = {}) {
  const out = {};
  for (const w of widths) {
    const file = `${prefix}-${w}.webp`;
    await sharp(buf).resize({ width: w, withoutEnlargement: true }).webp({ quality }).toFile(path.join(dir, file));
    out[w] = toSitePath(path.join(dir, file));
  }
  return out;
}

async function captureTool(browser, tool, previous) {
  const dir = path.join(TOOLS_DIR, tool.slug);
  await fs.mkdir(dir, { recursive: true });
  const notes = [];
  const entry = { slug: tool.slug, name: tool.name, source: tool.url, capturedAt: new Date().toISOString(), alt: `Screenshot of the ${tool.name} website` };

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, userAgent: UA, locale: "en-US", colorScheme: "light"
  });
  const page = await context.newPage();
  const cfg = tool.capture || {};
  try {
    await page.goto(tool.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    for (const sel of CONSENT_SELECTORS) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        await el.click({ timeout: 1500 }).catch(() => {});
        notes.push(`dismissed banner with ${sel}`);
        break;
      }
    }
    for (const sel of cfg.click || []) await page.locator(sel).first().click({ timeout: 3000 }).catch(() => notes.push(`click failed: ${sel}`));
    if ((cfg.hide || []).length) await page.addStyleTag({ content: `${cfg.hide.join(",")}{display:none!important}` });
    await sleep(cfg.wait ?? 800);

    // Metadata and brand elements
    const meta = await page.evaluate(() => {
      const abs = (u) => { if (!u) return null; try { return new URL(u, document.baseURI).href; } catch { return null; } };
      const q = (s) => document.querySelector(s);
      const content = (s) => q(s)?.getAttribute("content") || null;
      const icons = [...document.querySelectorAll("link[rel]")].flatMap((l) => {
        const rel = l.getAttribute("rel").toLowerCase().split(/\s+/);
        const href = abs(l.getAttribute("href"));
        if (!href) return [];
        if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) return [{ href, sizes: l.getAttribute("sizes"), type: l.getAttribute("type"), kind: "apple" }];
        if (rel.includes("icon")) return [{ href, sizes: l.getAttribute("sizes"), type: l.getAttribute("type"), kind: "icon" }];
        return [];
      });
      return {
        title: document.title || null,
        description: content('meta[name="description"]') || content('meta[property="og:description"]'),
        themeColor: content('meta[name="theme-color"]'),
        manifest: abs(q('link[rel="manifest"]')?.getAttribute("href") || ""),
        og: abs(content('meta[property="og:image"]') || content('meta[name="twitter:image"]') || ""),
        icons
      };
    });
    entry.pageTitle = meta.title;
    entry.pageDescription = meta.description;

    // Screenshots
    if (cfg.shot !== false) {
      if (cfg.scroll) { await page.evaluate((y) => window.scrollTo(0, y), cfg.scroll); await sleep(600); }
      const desktop = await page.screenshot({ type: "png", fullPage: false });
      entry.shot = await saveVariants(desktop, dir, "shot", SHOT_WIDTHS);
    } else {
      notes.push("screenshot skipped by override");
      for (const f of await fs.readdir(dir)) if (/^(shot|mobile)-/.test(f)) await fs.rm(path.join(dir, f));
    }
    if (cfg.mobile !== false && cfg.shot !== false) {
      const mpage = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: UA, isMobile: true, hasTouch: true, locale: "en-US" });
      const mp = await mpage.newPage();
      try {
        await mp.goto(tool.url, { waitUntil: "load", timeout: 30000 });
        await mp.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        for (const sel of CONSENT_SELECTORS) {
          const el = mp.locator(sel).first();
          if (await el.isVisible({ timeout: 300 }).catch(() => false)) { await el.click({ timeout: 1500 }).catch(() => {}); break; }
        }
        if ((cfg.hide || []).length) await mp.addStyleTag({ content: `${cfg.hide.join(",")}{display:none!important}` });
        await sleep(cfg.wait ?? 800);
        entry.mobile = await saveVariants(await mp.screenshot({ type: "png" }), dir, "mobile", [390, 780]);
      } catch (e) { notes.push(`mobile screenshot failed: ${e.message}`); }
      await mpage.close();
    }

    // Icon: the page's declared icons, then the web manifest's, then any override
    const candidates = [...meta.icons];
    if (meta.manifest) {
      try {
        const m = JSON.parse((await download(meta.manifest, 1e6)).buf.toString("utf8"));
        for (const i of m.icons || []) {
          const href = new URL(i.src, meta.manifest).href;
          candidates.push({ href, sizes: i.sizes, type: i.type, kind: "manifest" });
        }
      } catch (e) { notes.push(`manifest unreadable: ${e.message}`); }
    }
    if (tool.brand?.icon) candidates.push({ href: tool.brand.icon, sizes: "1024x1024", kind: "override" });
    const best = tool.brand?.icon ? candidates.find((c) => c.kind === "override") : pickIcon(candidates);
    let iconBuf = null;
    if (best) {
      try {
        const { buf, type } = await download(best.href, 5e6);
        const isSvg = best.isSvg || type === "image/svg+xml";
        if (isSvg) {
          await fs.writeFile(path.join(dir, "icon.svg"), buf);
          entry.icon = { svg: toSitePath(path.join(dir, "icon.svg")) };
          iconBuf = await sharp(buf, { density: 384 }).resize({ width: 512 }).png().toBuffer();
          entry.icon.from = best.href; entry.icon.scalable = true;
        } else {
          const info = await sharp(buf).metadata();
          // Trim empty margins and pad to a square so icons sit centred in their tile
          try {
            const t = await sharp(buf).trim({ threshold: 5 }).toBuffer({ resolveWithObject: true });
            const side = Math.max(t.info.width, t.info.height);
            iconBuf = await sharp(t.data).resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
          } catch { iconBuf = buf; }
          entry.icon = { from: best.href, sourceWidth: info.width, scalable: false, lowRes: (info.width || 0) < 128 };
        }
        Object.assign(entry.icon, await saveVariants(iconBuf, dir, "icon", ICON_WIDTHS, { quality: 90 }));
      } catch (e) { notes.push(`icon failed: ${e.message}`); }
    } else notes.push("no usable icon found (an .ico favicon alone can't be converted)");

    // Last resort: the favicon service Chrome uses. It only answers when the site really has an icon, so there is
    // no placeholder globe. Skipped when the page already gave us one, or when the maker's override is in use.
    if (!entry.icon && !tool.brand?.icon) {
      entry.iconFallback = true;
      try {
        const host = new URL(tool.url).origin;
        const { buf } = await download(`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(host)}&size=256`, 2e6);
        const info = await sharp(buf).metadata();
        if ((info.width || 0) >= 32) {
          iconBuf = await sharp(buf).resize(Math.max(info.width, 256), Math.max(info.width, 256), { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
          entry.icon = { from: "favicon service", sourceWidth: info.width, scalable: false, lowRes: info.width < 128 };
          Object.assign(entry.icon, await saveVariants(iconBuf, dir, "icon", ICON_WIDTHS, { quality: 90 }));
          notes.push("icon taken from the favicon service");
        }
      } catch (e) { notes.push(`favicon fallback failed: ${e.message}`); }
    }

    // Social image
    const ogUrl = tool.brand?.ogImage || meta.og;
    if (ogUrl) {
      try {
        const { buf } = await download(ogUrl, 8e6);
        entry.social = { from: ogUrl, ...(await saveVariants(buf, dir, "social", [600, 1200])) };
      } catch (e) { notes.push(`social image failed: ${e.message}`); }
    }

    // Brand colour: the maker's theme colour first, then the icon's dominant colour
    entry.color = validColor(meta.themeColor);
    if (!entry.color && iconBuf) {
      try {
        const { dominant } = await sharp(iconBuf).resize(64, 64, { fit: "inside" }).flatten({ background: "#ffffff" }).stats();
        entry.color = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
        entry.colorFrom = "icon";
      } catch { /* leave unset */ }
    } else if (entry.color) entry.colorFrom = "theme-color";
  } finally {
    await context.close();
  }
  entry.notes = notes;
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(entry, null, 2) + "\n");
  return entry;
}

async function main() {
  const tools = await readJson(DATA, null);
  if (!Array.isArray(tools)) throw new Error(`Could not read a tool list from ${DATA}`);
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  const manifest = await readJson(MANIFEST, { version: 1, tools: {} });
  const report = { startedAt: new Date().toISOString(), captured: [], skipped: [], failed: [] };

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    for (const tool of tools) {
      if (ONLY && tool.slug !== ONLY) continue;
      const prev = manifest.tools[tool.slug];

      if (tool.images === false) {
        await fs.rm(path.join(TOOLS_DIR, tool.slug), { recursive: true, force: true });
        delete manifest.tools[tool.slug];
        report.skipped.push({ slug: tool.slug, reason: "maker opt-out" });
        log(`- ${tool.slug}: skipped (opt-out), existing images removed`);
        continue;
      }
      const cfgKey = JSON.stringify([tool.url, tool.capture || null, tool.brand || null]);
      const needsIcon = prev && !prev.icon && !prev.iconFallback;   // captured before the favicon fallback existed
      const fresh = prev && prev.cfg === cfgKey && !needsIcon && Date.now() - Date.parse(prev.capturedAt) < MAX_AGE_DAYS * 864e5;
      if (fresh && !FORCE && !ONLY) { report.skipped.push({ slug: tool.slug, reason: "recent" }); log(`- ${tool.slug}: recent, skipped`); continue; }
      if (!(await allowedByRobots(tool.url))) {
        report.skipped.push({ slug: tool.slug, reason: "robots.txt disallows" });
        log(`- ${tool.slug}: robots.txt disallows ${tool.url}, skipped`);
        continue;
      }
      try {
        log(`- ${tool.slug}: capturing ${tool.url}`);
        const entry = await captureTool(browser, tool, prev);
        entry.cfg = cfgKey;
        manifest.tools[tool.slug] = entry;
        report.captured.push({ slug: tool.slug, notes: entry.notes });
        for (const n of entry.notes) log(`    note: ${n}`);
      } catch (e) {
        report.failed.push({ slug: tool.slug, error: e.message });
        log(`  ! ${tool.slug} failed: ${e.message} (keeping any earlier images)`);
      }
      await sleep(PAUSE_MS);
    }
  } finally {
    await browser.close();
  }

  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(OUT, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
  log(`\nDone: ${report.captured.length} captured, ${report.skipped.length} skipped, ${report.failed.length} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
