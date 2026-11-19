// One-off migration: the sign-in widget on the static archive pages
// (historical/**) showed the first letter of the account name where the app
// shows the avatar the user picked in Settings > Profile. This adds a small
// profile lookup (the same /.netlify/functions/user-profile call the app
// makes) to the widget's inline script and renders the chosen avatar and
// display name. Chrome only - no content change, so sitemap lastmod is left
// alone. Idempotent: skips files that already carry applyProfileAvatar.
// The avatar table mirrors PROFILE_AVATARS in src/app.jsx - keep in step.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const HISTORICAL_DIR = path.join(ROOT, "historical");

export const AVATAR_FN = `  var PROFILE_AVATARS = {"blitz-edge":{img:"/branding/blitz-edge-icon.png"},"bolt":{g:"\\u26A1",c:"#fd7f01"},"check":{g:"\\u2713",c:"var(--accent)"},"football":{g:"\\uD83C\\uDFC8"},"trophy":{g:"\\uD83C\\uDFC6"},"medal":{g:"\\uD83E\\uDD47"},"target":{g:"\\uD83C\\uDFAF"},"fire":{g:"\\uD83D\\uDD25"},"goat":{g:"\\uD83D\\uDC10"},"chart":{g:"\\uD83D\\uDCC8"},"shield":{g:"\\uD83D\\uDEE1\\uFE0F"},"cleat":{g:"\\uD83D\\uDC5F"},"cap":{g:"\\uD83E\\uDDE2"},"clipboard":{g:"\\uD83D\\uDCCB"},"party":{g:"\\uD83C\\uDF89"},"muscle":{g:"\\uD83D\\uDCAA"},"flag":{g:"\\uD83D\\uDEA9"},"clock":{g:"\\u23F1\\uFE0F"},"stadium":{g:"\\uD83C\\uDFDF\\uFE0F"},"horn":{g:"\\uD83D\\uDCE3"}};
  // The avatar and display name live on the profile record, not on the
  // identity user, so they need the same lookup the app does.
  function applyProfileAvatar(user) {
    try {
      if (!user || typeof user.jwt !== "function" || !avatarBtn) return;
      user.jwt().then(function (token) {
        return fetch("/.netlify/functions/user-profile", { headers: { Authorization: "Bearer " + token } });
      }).then(function (res) { return res && res.ok ? res.json() : null; }).then(function (p) {
        if (!p) return;
        if (p.displayName) {
          if (dropdownName) dropdownName.textContent = p.displayName;
          avatarBtn.textContent = String(p.displayName).charAt(0).toUpperCase();
        }
        var a = p.avatar && PROFILE_AVATARS[p.avatar];
        if (!a) return;
        avatarBtn.textContent = "";
        avatarBtn.style.background = "var(--card-bg)";
        avatarBtn.style.borderColor = "var(--card-border)";
        if (a.img) {
          var im = document.createElement("img");
          im.src = a.img; im.alt = ""; im.style.cssText = "width:66%;height:66%;object-fit:contain";
          avatarBtn.appendChild(im);
        } else {
          var sp = document.createElement("span");
          sp.textContent = a.g; if (a.c) sp.style.color = a.c;
          avatarBtn.appendChild(sp);
        }
      }).catch(function () {});
    } catch (e) {}
  }
`;

const ANCHOR_FN = "  function renderSignedOut() {";
const OLD_LINE = "      avatarBtn.textContent = name.charAt(0).toUpperCase();\n";
export const NEW_LINE = OLD_LINE + '      avatarBtn.style.background = ""; avatarBtn.style.borderColor = "";\n      applyProfileAvatar(user);\n';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".html")) yield p;
  }
}

async function main() {
  let changed = 0, skipped = 0, odd = 0;
  for await (const file of walk(HISTORICAL_DIR)) {
    const html = await readFile(file, "utf8");
    if (html.includes("applyProfileAvatar")) { skipped++; continue; }
    if (html.split(ANCHOR_FN).length !== 2 || html.split(OLD_LINE).length !== 2) { odd++; continue; }
    await writeFile(file, html.replace(ANCHOR_FN, AVATAR_FN + ANCHOR_FN).replace(OLD_LINE, NEW_LINE), "utf8");
    changed++;
  }
  console.log(`retrofit-archive-avatar: ${changed} updated, ${skipped} already done, ${odd} without the widget (left alone).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
