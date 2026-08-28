// Compare this build to the latest GitHub Release. Pure enough to unit-test:
// fetching and running the installer stay in main.js.

const REPO = "imjakezimmer32/scrappy";
const RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PAGE = `https://github.com/${REPO}/releases/latest`;
const SITE = "https://imscrappy.dev";

function parseVersion(v) {
  const m = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, current) {
  return cmpVersion(latest, current) > 0;
}

function pickInstaller(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const named = list.find((a) => /^Scrappy-Setup-.*\.exe$/i.test(a.name || "") && !/\.blockmap$/i.test(a.name || ""));
  if (named) return named;
  return list.find((a) => /\.exe$/i.test(a.name || "") && !/\.blockmap$/i.test(a.name || "")) || null;
}

function summarizeRelease(release, currentVersion) {
  if (!release || release.message === "Not Found") {
    return { ok: false, error: "no_release", current: currentVersion };
  }
  const latest = String(release.tag_name || release.name || "").replace(/^v/i, "");
  const asset = pickInstaller(release.assets);
  return {
    ok: true,
    current: currentVersion,
    latest,
    newer: isNewer(latest, currentVersion),
    name: release.name || latest,
    url: release.html_url || DOWNLOAD_PAGE,
    downloadUrl: asset ? asset.browser_download_url || null : null,
    downloadName: asset ? asset.name : null,
  };
}

module.exports = {
  REPO,
  RELEASES_LATEST,
  DOWNLOAD_PAGE,
  SITE,
  parseVersion,
  cmpVersion,
  isNewer,
  pickInstaller,
  summarizeRelease,
};
