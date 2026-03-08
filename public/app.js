// ─── Element refs ─────────────────────────────────────────────────────────
const statusEl         = document.getElementById("status");
const tracksEl         = document.getElementById("tracks");
const refreshBtn       = document.getElementById("refresh");

const statTracksEl     = document.getElementById("stat-tracks");
const statArtistsEl    = document.getElementById("stat-artists");
const statLastEl       = document.getElementById("stat-last");
const statUpdatedEl    = document.getElementById("stat-updated");

const nowCoverEl       = document.getElementById("now-cover");
const nowTrackEl       = document.getElementById("now-track");
const nowArtistsEl     = document.getElementById("now-artists");
const nowAlbumEl       = document.getElementById("now-album");
const nowProgressEl    = document.getElementById("now-progress");
const nowProgressBarEl = document.getElementById("now-progress-bar");
const nowLinkEl        = document.getElementById("now-link");
const eqEl             = document.getElementById("eq");
const nowPanelEl       = document.querySelector(".now-panel");
const revealEls        = document.querySelectorAll(".reveal");

// ─── State ───────────────────────────────────────────────────────────────
let loadInFlight        = false;
let cooldownUntil       = 0;
let nowPlayingTicker    = null;
let progressTicker      = null;
let nowPlaybackState    = null;
let currentNowSignature = "";
let latestScroll        = 0;
let scrollTicking       = false;

// Mark JS available for reveal animations
document.documentElement.classList.add("js");

// ─── SVG snippets ────────────────────────────────────────────────────────
const spotifyIconSm = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="9"/>
  <path d="m6.5 10.1c3.7-1.1 7.5-.8 10.9.9"/>
  <path d="m7.5 13c2.9-.8 5.8-.6 8.4.7"/>
  <path d="m8.6 15.8c2-.5 4-.3 5.7.5"/>
</svg>`;

const refreshIconSvg = `<svg class="btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 7v5h-5"/>
  <path d="M4 17v-5h5"/>
  <path d="m20 12a8 8 0 0 0-13.6-5.6l-2.4 2.6"/>
  <path d="m4 12a8 8 0 0 0 13.6 5.6l2.4-2.6"/>
</svg>`;

// ─── Utilities ───────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtTimestamp(iso) {
  const then    = new Date(iso).getTime();
  const now     = Date.now();
  const diffMs  = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH   = Math.floor(diffMs / 3_600_000);

  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffH   < 24) return `${diffH}h ago`;

  return new Intl.DateTimeFormat(undefined, {
    year:   "numeric",
    month:  "short",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDate(iso) {
  return new Intl.DateTimeFormat(undefined, {
    year:   "numeric",
    month:  "short",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtClockDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min   = Math.floor(total / 60);
  const sec   = String(total % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function buildNowSignature(item) {
  if (!item) return "";
  return [
    item.track_name   || "",
    item.artists      || "",
    item.album        || "",
    item.external_url || "",
  ].join("|");
}

// ─── Network ─────────────────────────────────────────────────────────────
async function fetchJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });

  if (res.status === 401) return { unauthenticated: true };

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || 1);
    return { rateLimited: true, retryAfter };
  }

  if (!res.ok) throw new Error(`http ${res.status}`);

  return { data: await res.json() };
}

// ─── Stats ───────────────────────────────────────────────────────────────
function setStats(items, fetchedAt = null) {
  const count   = items.length;
  const artists = new Set();

  for (const item of items) {
    const value = String(item.artists || "");
    for (const artist of value.split(",")) {
      const normalized = artist.trim().toLowerCase();
      if (normalized) artists.add(normalized);
    }
  }

  let latest = null;
  for (const item of items) {
    const stamp = new Date(item.played_at).getTime();
    if (!Number.isNaN(stamp) && (latest === null || stamp > latest)) {
      latest = stamp;
    }
  }

  statTracksEl.textContent  = String(count);
  statArtistsEl.textContent = String(artists.size);
  statLastEl.textContent    = latest ? fmtDate(new Date(latest).toISOString()) : "none";
  statUpdatedEl.textContent = fetchedAt ? fmtDate(fetchedAt) : "\u2014";
}

// ─── Reveal observer ─────────────────────────────────────────────────────
function setupRevealObserver() {
  if (!("IntersectionObserver" in window)) {
    for (const el of revealEls) el.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
  );

  for (const el of revealEls) observer.observe(el);
}

// ─── Scroll motion ───────────────────────────────────────────────────────
function applyScrollMotion() {
  document.documentElement.style.setProperty("--scroll", String(latestScroll));
  scrollTicking = false;
}

function onScroll() {
  latestScroll = window.scrollY || window.pageYOffset || 0;
  if (!scrollTicking) {
    scrollTicking = true;
    window.requestAnimationFrame(applyScrollMotion);
  }
}

// ─── Progress ticker ─────────────────────────────────────────────────────
function setNowProgress(progressMs, durationMs) {
  const safeDuration = Math.max(0, Number(durationMs || 0));
  const safeProgress = Math.min(
    Math.max(0, Number(progressMs || 0)),
    safeDuration || Number(progressMs || 0)
  );

  if (!safeDuration) {
    nowProgressEl.textContent    = "\u2014";
    nowProgressBarEl.style.width = "0%";
    return;
  }

  nowProgressEl.textContent = `${fmtClockDuration(safeProgress)} / ${fmtClockDuration(safeDuration)}`;
  const ratio = Math.max(0, Math.min(100, (safeProgress / safeDuration) * 100));
  nowProgressBarEl.style.width = `${ratio}%`;
}

function stopProgressTicker() {
  if (progressTicker) {
    clearInterval(progressTicker);
    progressTicker = null;
  }
}

function startProgressTicker() {
  stopProgressTicker();
  if (!nowPlaybackState || !nowPlaybackState.isPlaying) return;

  progressTicker = setInterval(() => {
    if (!nowPlaybackState || !nowPlaybackState.isPlaying) {
      stopProgressTicker();
      return;
    }
    const elapsed      = Date.now() - nowPlaybackState.anchorAt;
    const nextProgress = nowPlaybackState.anchorProgress + elapsed;
    setNowProgress(nextProgress, nowPlaybackState.duration);
  }, 1000);
}

// ─── Render: track list ──────────────────────────────────────────────────
function renderTracks(items, fetchedAt) {
  setStats(items, fetchedAt);
  tracksEl.classList.add("refreshing");

  if (!items.length) {
    window.setTimeout(() => {
      tracksEl.innerHTML = "";
      tracksEl.classList.remove("refreshing");
    }, 180);
    statusEl.textContent = "no recent tracks found";
    return;
  }

  statusEl.textContent = `showing ${items.length} recent tracks`;

  window.setTimeout(() => {
    tracksEl.innerHTML = items
      .map((item, index) => {
        const idx = String(index + 1).padStart(2, "0");

        const coverHtml = item.album_image
          ? `<img class="track-cover" src="${escapeHtml(item.album_image)}" alt="album cover" loading="lazy" />`
          : `<div class="track-cover-placeholder" aria-hidden="true"></div>`;

        const linkHtml = item.external_url
          ? `<a class="track-link" href="${escapeHtml(item.external_url)}" target="_blank" rel="noreferrer">${spotifyIconSm} open in spotify</a>`
          : "";

        return `
          <li class="track-row" style="--i:${index};">
            <span class="track-index">${escapeHtml(idx)}</span>
            ${coverHtml}
            <div class="track-meta">
              <p class="track-name">${escapeHtml(item.track_name)}</p>
              <p class="track-sub">${escapeHtml(item.artists)} &bull; ${escapeHtml(item.album)}</p>
              <p class="track-sub track-timestamp">${escapeHtml(fmtTimestamp(item.played_at))}</p>
              ${linkHtml}
            </div>
          </li>
        `;
      })
      .join("");

    tracksEl.classList.remove("refreshing");
  }, 180);
}

// ─── Render: now playing ─────────────────────────────────────────────────
function renderNowPlaying(data) {
  const item      = data?.item;
  const isPlaying = Boolean(data?.is_playing && item);
  const signature = buildNowSignature(item);

  currentNowSignature = signature;

  if (!item) {
    stopProgressTicker();
    nowPlaybackState = null;
    nowCoverEl.removeAttribute("src");
    nowTrackEl.textContent   = "nothing right now";
    nowArtistsEl.textContent = "\u2014";
    nowAlbumEl.textContent   = "\u2014";
    setNowProgress(0, 0);
    nowLinkEl.classList.add("hidden");
    eqEl.classList.add("eq-off");
    nowPanelEl.classList.remove("now-playing");
    return;
  }

  nowCoverEl.src           = item.album_image || "";
  nowTrackEl.textContent   = item.track_name  || "unknown";
  nowArtistsEl.textContent = item.artists     || "unknown";
  nowAlbumEl.textContent   = item.album       || "unknown";

  const progress = Number(data.progress_ms || 0);
  const duration = Number(item.duration_ms || 0);
  setNowProgress(progress, duration);

  if (item.external_url) {
    nowLinkEl.href = item.external_url;
    nowLinkEl.classList.remove("hidden");
  } else {
    nowLinkEl.classList.add("hidden");
  }

  if (isPlaying) {
    eqEl.classList.remove("eq-off");
    nowPanelEl.classList.add("now-playing");
    nowPlaybackState = {
      isPlaying:      true,
      anchorAt:       Date.now(),
      anchorProgress: progress,
      duration,
    };
    startProgressTicker();
  } else {
    eqEl.classList.add("eq-off");
    nowPanelEl.classList.remove("now-playing");
    stopProgressTicker();
    nowPlaybackState = {
      isPlaying:      false,
      anchorAt:       Date.now(),
      anchorProgress: progress,
      duration,
    };
  }
}

// ─── UI states ───────────────────────────────────────────────────────────
function showDisconnected() {
  tracksEl.innerHTML = "";
  stopProgressTicker();
  currentNowSignature = "";
  renderNowPlaying(null);
  setStats([], null);
  statusEl.textContent = "not connected \u2014 click connect spotify to get started";
}

function showError() {
  statusEl.textContent = "failed to load data";
}

// ─── Button cooldown ─────────────────────────────────────────────────────
function setButtonCooldown(seconds = 2.5) {
  cooldownUntil = Date.now() + Math.floor(seconds * 1000);
}

function updateRefreshButton() {
  const remaining = cooldownUntil - Date.now();
  const cooling   = remaining > 0;
  refreshBtn.disabled = loadInFlight || cooling;

  if (loadInFlight) {
    refreshBtn.classList.add("loading");
    refreshBtn.innerHTML = `${refreshIconSvg} loading...`;
    return;
  }

  refreshBtn.classList.remove("loading");

  if (cooling) {
    const sec = Math.max(1, Math.ceil(remaining / 1000));
    refreshBtn.textContent = `wait ${sec}s`;
    return;
  }

  refreshBtn.innerHTML = `${refreshIconSvg} refresh`;
}

// ─── Load now playing (background poll) ───────────────────────────────────
async function loadNowPlaying({ silent = false } = {}) {
  try {
    const result = await fetchJson("/api/now-playing");

    if (result.unauthenticated) {
      if (!silent) showDisconnected();
      return;
    }

    if (result.rateLimited) {
      if (!silent) statusEl.textContent = `slow down \u2014 retry in ${result.retryAfter}s`;
      return;
    }

    renderNowPlaying(result.data);
  } catch (error) {
    if (!silent) console.error(error);
  }
}

// ─── Load all ──────────────────────────────────────────────────────────────
async function loadAll() {
  if (loadInFlight) return;

  if (Date.now() < cooldownUntil) {
    updateRefreshButton();
    return;
  }

  loadInFlight = true;
  updateRefreshButton();
  statusEl.textContent = "loading...";

  try {
    const [recentResult, nowResult] = await Promise.all([
      fetchJson("/api/recent"),
      fetchJson("/api/now-playing"),
    ]);

    if (recentResult.unauthenticated || nowResult.unauthenticated) {
      showDisconnected();
      return;
    }

    if (recentResult.rateLimited || nowResult.rateLimited) {
      const seconds = Math.max(
        recentResult.retryAfter || 1,
        nowResult.retryAfter   || 1
      );
      statusEl.textContent = `rate limited \u2014 retry in ${seconds}s`;
      setButtonCooldown(seconds);
      return;
    }

    renderTracks(recentResult.data.items || [], recentResult.data.fetched_at || null);
    renderNowPlaying(nowResult.data || null);

    if (nowPlayingTicker) clearInterval(nowPlayingTicker);

    nowPlayingTicker = setInterval(() => {
      loadNowPlaying({ silent: true });
    }, 25_000);

  } catch (error) {
    showError();
    console.error(error);
  } finally {
    loadInFlight = false;
    if (Date.now() >= cooldownUntil) setButtonCooldown(2.5);
    updateRefreshButton();
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────
refreshBtn.addEventListener("click", () => {
  loadAll();
});

setupRevealObserver();
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

setInterval(updateRefreshButton, 500);
updateRefreshButton();
loadAll();