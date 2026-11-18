/**
 * social-card.mjs - the matchup image attached to @RealBlitzOdds posts.
 *
 * scripts/social-verify.mjs hands this a list of games (the ones the post's
 * text actually names, in the order it names them) and gets back a 1200x675
 * PNG: Blitz Odds wordmark, a title line, then one row per game with both
 * team badges, the line and the total. Same badges the site uses:
 *   NFL      team-badges/{ABBR}.png
 *   college  team-badges/cfb/{espnTeamId}.png, else the two-colour diagonal
 *            crest drawn from ESPN's team colours (as the app does)
 *
 * Rendering is SVG -> PNG through @resvg/resvg-js, with Inter bundled under
 * social/fonts so the runner's fonts don't matter. resvg is not a site
 * dependency (Netlify never needs it): ensureResvg() installs it on first use
 * into .social-deps/, which is gitignored.
 *
 *   node scripts/social-card.mjs --demo out.png   renders a sample card
 */

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const RESVG_VERSION = "2.6.2";
const DEPS_DIR = path.join(REPO_ROOT, ".social-deps");

// Bump when the card design changes so already-scheduled posts get re-rendered.
export const CARD_VERSION = 3;
export const CARD_W = 1200;
export const CARD_H = 675;

const C = {
  bg: "#0b1220",
  bg2: "#111a2c",
  row: "#151f33",
  rowBorder: "#22304a",
  text: "#f1f5fb",
  muted: "#8fa0bb",
  accent: "#4fd1c5",
  orange: "#f26b21",
};

// ---------------------------------------------------------------------------
// Dependencies and assets
// ---------------------------------------------------------------------------

let resvgMod = null;
async function ensureResvg() {
  if (resvgMod) return resvgMod;
  const tryLoad = (base) => {
    try { return createRequire(path.join(base, "noop.js"))("@resvg/resvg-js"); } catch { return null; }
  };
  resvgMod = tryLoad(REPO_ROOT) || tryLoad(DEPS_DIR);
  if (!resvgMod) {
    await mkdir(DEPS_DIR, { recursive: true });
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", DEPS_DIR, `@resvg/resvg-js@${RESVG_VERSION}`], { stdio: "inherit" });
    resvgMod = tryLoad(DEPS_DIR);
  }
  if (!resvgMod) throw new Error("could not load @resvg/resvg-js");
  return resvgMod;
}

const dataUriCache = new Map();
async function pngDataUri(rel) {
  if (dataUriCache.has(rel)) return dataUriCache.get(rel);
  const p = path.join(REPO_ROOT, rel);
  const uri = existsSync(p) ? `data:image/png;base64,${(await readFile(p)).toString("base64")}` : null;
  dataUriCache.set(rel, uri);
  return uri;
}

export function badgePath(team) {
  if (team.league === "cfb") return `team-badges/cfb/${team.id}.png`;
  return `team-badges/${team.id}.png`;
}

// ---------------------------------------------------------------------------
// Text helpers (resvg lays out text but can't tell us widths, so estimate)
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Rough Inter Bold advance widths, in em. Good to a few percent for names.
function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[ il.,:;'|!]/.test(ch)) w += 0.3;
    else if (/[fjrtI1()\-]/.test(ch)) w += 0.42;
    else if (/[mwMW]/.test(ch)) w += 0.9;
    else if (/[A-Z0-9#&]/.test(ch)) w += 0.68;
    else w += 0.58;
  }
  return w * size;
}

function fitSize(s, size, maxW, min = 18) {
  let f = size;
  while (f > min && textWidth(s, f) > maxW) f -= 1;
  return f;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function fallbackCrest(team, x, y, s) {
  const a = `#${(team.color || "334155").replace(/^#/, "")}`;
  const b = `#${(team.altColor || "94a3b8").replace(/^#/, "")}`;
  const r = s * 0.22;
  const id = `cr${Math.random().toString(36).slice(2, 8)}`;
  const label = esc((team.abbr || "").slice(0, 4));
  const fs = label.length > 3 ? s * 0.26 : s * 0.32;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}"/></clipPath>
  <g clip-path="url(#${id})"><rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${a}"/>
  <path d="M${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z" fill="${b}"/></g>
  <text x="${x + s / 2}" y="${y + s / 2 + fs * 0.36}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="${fs}" fill="#fff" stroke="#0008" stroke-width="${s * 0.03}" paint-order="stroke">${label}</text>`;
}

async function badge(team, x, y, s) {
  const uri = await pngDataUri(badgePath(team));
  if (!uri) return fallbackCrest(team, x, y, s);
  return `<image x="${x}" y="${y}" width="${s}" height="${s}" href="${uri}" preserveAspectRatio="xMidYMid meet"/>`;
}

function teamLabel(t) {
  return t.name || t.abbr || t.id;
}

// One row: [badge] AWAY   at   HOME [badge]   | line / O/U
async function gameRow(g, y, h, compact) {
  const pad = 40;
  const x0 = pad, x1 = CARD_W - pad;
  const s = Math.round(Math.min(h * 0.68, 150));
  const by = y + (h - s) / 2;
  // Spotlight rows (one or two games) scale everything up from the 120px base.
  const k = compact ? 1 : Math.min(1.6, Math.max(1, h / 120));
  const nameSize = compact ? 28 : Math.round(34 * k);
  const rankSize = Math.round(nameSize * 0.62);
  const lineBoxW = Math.round(250 * k);
  const lineX = x1 - lineBoxW - 16;
  const mid = (x0 + lineX) / 2 + 8;

  const awayBadgeX = x0 + 20;
  const homeBadgeX = lineX - 24 - s;
  const nameMax = mid - 34 - (awayBadgeX + s + 16);

  const side = (t, anchorX, anchor) => {
    const rank = t.rank ? `#${t.rank}` : "";
    const nm = teamLabel(t);
    const rw = rank ? textWidth(rank, rankSize) + 8 : 0;
    const fs = fitSize(nm, nameSize, nameMax - rw);
    const cy = y + h / 2 + fs * 0.36;
    const metaY = cy + (compact ? 22 : Math.round(26 * k));
    const rankTs = rank ? `<tspan fill="${C.accent}" font-size="${rankSize}">${esc(rank)}&#160;</tspan>` : "";
    const ta = anchor === "start" ? "" : ' text-anchor="end"';
    let out = `<text x="${anchorX}" y="${cy}"${ta} font-family="Inter" font-weight="800" font-size="${fs}" fill="${C.text}">${rankTs}<tspan>${esc(nm)}</tspan></text>`;
    if (t.record && !compact) out += `<text x="${anchorX}" y="${metaY}"${ta} font-family="Inter" font-weight="600" font-size="${Math.round(17 * k)}" fill="${C.muted}">${esc(t.record)}</text>`;
    return out;
  };

  const lineText = g.lineText || "Line not posted";
  const ouText = g.ouText || "";
  const lineSize = fitSize(lineText, compact ? (ouText ? 24 : 26) : Math.round(32 * k), lineBoxW - 28, 16);
  const metaText = g.meta || "";

  let svg = `<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${h}" rx="18" fill="${C.row}" stroke="${C.rowBorder}" stroke-width="1.5"/>`;
  svg += await badge(g.away, awayBadgeX, by, s);
  svg += side(g.away, awayBadgeX + s + 16, "start");
  svg += `<text x="${mid}" y="${y + h / 2 + 8}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="${Math.round(22 * k)}" fill="${C.muted}">at</text>`;
  if (metaText) svg += `<text x="${mid}" y="${y + h / 2 + (compact ? 30 : Math.round(36 * k))}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${compact ? 14 : Math.round(16 * k)}" fill="${C.muted}">${esc(metaText)}</text>`;
  svg += side(g.home, homeBadgeX - 16, "end");
  svg += await badge(g.home, homeBadgeX, by, s);

  const lbH = compact ? h - 14 : Math.min(h - 24, Math.round(106 * k));
  const lb = { x: lineX, y: y + (h - lbH) / 2, w: lineBoxW, h: lbH };
  svg += `<rect x="${lb.x}" y="${lb.y}" width="${lb.w}" height="${lb.h}" rx="14" fill="${C.bg}" stroke="${g.hasLine ? C.accent : C.rowBorder}" stroke-opacity="${g.hasLine ? 0.55 : 1}" stroke-width="1.5"/>`;
  const ty = ouText ? lb.y + lb.h / 2 + lineSize * 0.36 - (compact ? 7 : Math.round(12 * k)) : lb.y + lb.h / 2 + lineSize * 0.36;
  svg += `<text x="${lb.x + lb.w / 2}" y="${ty}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="${lineSize}" fill="${g.hasLine ? C.accent : C.muted}">${esc(lineText)}</text>`;
  if (ouText) svg += `<text x="${lb.x + lb.w / 2}" y="${ty + (compact ? 18 : Math.round(30 * k))}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${compact ? 14 : Math.round(19 * k)}" fill="${C.muted}">${esc(ouText)}</text>`;
  return svg;
}

// One game: both crests big, names under them, the line in a box below.
async function spotlight(g) {
  const s = 176, by = 168, cxA = 300, cxH = CARD_W - 300, cx = CARD_W / 2;
  let svg = `<rect x="40" y="146" width="${CARD_W - 80}" height="${CARD_H - 146 - 62}" rx="22" fill="${C.row}" stroke="${C.rowBorder}" stroke-width="1.5"/>`;
  const side = async (t, x) => {
    let out = await badge(t, x - s / 2, by, s);
    const rank = t.rank ? `#${t.rank} ` : "";
    const fs = fitSize(rank + teamLabel(t), 44, 400, 24);
    out += `<text x="${x}" y="${by + s + 54}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="${fs}" fill="${C.text}">${rank ? `<tspan fill="${C.accent}" font-size="${Math.round(fs * 0.7)}">${esc(rank)}</tspan>` : ""}${esc(teamLabel(t))}</text>`;
    if (t.record) out += `<text x="${x}" y="${by + s + 86}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="20" fill="${C.muted}">${esc(t.record)}</text>`;
    return out;
  };
  svg += await side(g.away, cxA);
  svg += await side(g.home, cxH);
  svg += `<text x="${cx}" y="${by + s / 2 - 4}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="34" fill="${C.muted}">at</text>`;
  if (g.meta) svg += `<text x="${cx}" y="${by + s / 2 + 34}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="20" fill="${C.muted}">${esc(g.meta)}</text>`;
  const bw = 360, bh = 118, bx = cx - bw / 2, byy = by + s + 108;
  const lineText = g.lineText || "Line not posted";
  const ls = fitSize(lineText, 50, bw - 40, 22);
  svg += `<rect x="${bx}" y="${byy}" width="${bw}" height="${bh}" rx="16" fill="${C.bg}" stroke="${g.hasLine ? C.accent : C.rowBorder}" stroke-opacity="${g.hasLine ? 0.6 : 1}" stroke-width="2"/>`;
  svg += `<text x="${cx}" y="${byy + (g.ouText ? 62 : 76)}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="${ls}" fill="${g.hasLine ? C.accent : C.muted}">${esc(lineText)}</text>`;
  if (g.ouText) svg += `<text x="${cx}" y="${byy + 98}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="22" fill="${C.muted}">${esc(g.ouText)}</text>`;
  return svg;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * spec = {
 *   kicker: "NFL · WEEK 12" | "COLLEGE FOOTBALL · TOP 25",
 *   title:  "Biggest spreads",
 *   games:  [{ away, home, lineText, ouText, meta, hasLine }],  // max 6
 *   footer: "Lines: DraftKings consensus as of Wed 9:00 AM ET",
 * }
 * team = { league: "nfl"|"cfb", id, abbr, name, rank?, record?, color?, altColor? }
 */
export async function buildCardSvg(spec) {
  const games = spec.games.slice(0, 6);
  const top = 150, bottom = CARD_H - 62;
  const gap = games.length > 4 ? 10 : 14;
  const avail = bottom - top;
  const h = Math.min(130, Math.floor((avail - gap * (games.length - 1)) / Math.max(1, games.length)));
  const compact = h < 96;
  const used = h * games.length + gap * (games.length - 1);
  let y = top + Math.max(0, (avail - used) / 2);

  const wordmark = await pngDataUri("branding/blitz-odds-wordmark-dark-email.png");
  let rows = "";
  if (games.length === 1) rows = await spotlight(games[0]);
  else for (const g of games) { rows += await gameRow(g, y, h, compact); y += h + gap; }

  const kicker = esc(spec.kicker || "");
  const title = esc(spec.title || "");
  const titleSize = fitSize(spec.title || "", 44, CARD_W - 80 - 300, 26);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <linearGradient id="bgg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg2}"/><stop offset="1" stop-color="${C.bg}"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bgg)"/>
  <rect x="0" y="0" width="${CARD_W}" height="6" fill="${C.accent}"/>
  <text x="40" y="62" font-family="Inter" font-weight="800" font-size="20" letter-spacing="2.5" fill="${C.orange}">${kicker}</text>
  <text x="40" y="114" font-family="Inter" font-weight="800" font-size="${titleSize}" fill="${C.text}">${title}</text>
  ${wordmark ? `<image x="${CARD_W - 40 - 260}" y="34" width="260" height="${Math.round(260 * 119 / 440)}" href="${wordmark}"/>` : ""}
  ${rows}
  <text x="40" y="${CARD_H - 24}" font-family="Inter" font-weight="600" font-size="17" fill="${C.muted}">${esc(spec.footer || "")}</text>
  <text x="${CARD_W - 40}" y="${CARD_H - 24}" text-anchor="end" font-family="Inter" font-weight="800" font-size="20" fill="${C.accent}">blitz-odds.com</text>
</svg>`;
}

export async function renderCardPng(spec) {
  const { Resvg } = await ensureResvg();
  const svg = await buildCardSvg(spec);
  const fontDir = path.join(REPO_ROOT, "social", "fonts");
  const fontFiles = ["Inter-SemiBold.otf", "Inter-Bold.otf", "Inter-ExtraBold.otf"].map((f) => path.join(fontDir, f)).filter((f) => existsSync(f));
  const r = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontFiles, loadSystemFonts: fontFiles.length === 0, defaultFontFamily: "Inter" },
  });
  return r.render().asPng();
}

/** Alt text for the image - every row spelled out, for screen readers. */
export function cardAltText(spec) {
  const rows = spec.games.slice(0, 6).map((g) => {
    const n = (t) => `${t.rank ? `No. ${t.rank} ` : ""}${teamLabel(t)}`;
    return `${n(g.away)} at ${n(g.home)}: ${g.lineText || "no line"}${g.ouText ? `, ${g.ouText}` : ""}`;
  });
  return `${spec.kicker} - ${spec.title}. ${rows.join(". ")}.`.slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("social-card.mjs") && process.argv.includes("--demo")) {
  const out = process.argv[process.argv.indexOf("--demo") + 1] || "social-card-demo.png";
  const T = (id, name) => ({ league: "nfl", id, abbr: id, name });
  const spec = {
    kicker: "NFL · WEEK 12",
    title: "Biggest spreads as of Wednesday",
    games: [
      { away: T("NYG", "Giants"), home: T("DET", "Lions"), lineText: "DET -10.5", ouText: "O/U 47.5", meta: "Sun 1:00 PM ET", hasLine: true },
      { away: T("CLE", "Browns"), home: T("BAL", "Ravens"), lineText: "BAL -9", ouText: "O/U 44", meta: "Sun 1:00 PM ET", hasLine: true },
    ],
    footer: "Lines as of Wed 9:00 AM ET",
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, await renderCardPng(spec));
  console.log("wrote", out);
}
