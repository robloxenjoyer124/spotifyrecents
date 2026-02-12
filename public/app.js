const statusEl = document.getElementById("status");
const tracksEl = document.getElementById("tracks");
const refreshBtn = document.getElementById("refresh");

const statTracksEl = document.getElementById("stat-tracks");
const statArtistsEl = document.getElementById("stat-artists");
const statLastEl = document.getElementById("stat-last");
const statUpdatedEl = document.getElementById("stat-updated");

const nowCoverEl = document.getElementById("now-cover");
const nowTrackEl = document.getElementById("now-track");
const nowArtistsEl = document.getElementById("now-artists");
const nowAlbumEl = document.getElementById("now-album");
const nowProgressEl = document.getElementById("now-progress");
const nowProgressBarEl = document.getElementById("now-progress-bar");
const nowLinkEl = document.getElementById("now-link");
const eqEl = document.getElementById("eq");
const nowPanelEl = document.querySelector(".now-panel");
const revealEls = document.querySelectorAll(".reveal");

let loadInFlight = false;
let cooldownUntil = 0;
let nowPlayingTicker = null;
let progressTicker = null;
let nowPlaybackState = null;
let currentNowSignature = "";
let latestScroll = 0;
let scrollTicking = false;

document.documentElement.classList.add("js");

const spotifyIcon = `
<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
  <path d="m6.5 10.1c3.7-1.1 7.5-.8 10.9.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
  <path d="m7.5 13c2.9-.8 5.8-.6 8.4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
  <path d="m8.6 15.8c2-.5 4-.3 5.7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>
</svg>
`;

const refreshIcon = `
<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d="m20 7v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="m4 17v-5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
  <path d="m20 12a8 8 0 0 0-13.6-5.6l-2.4 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
  <path d="m4 12a8 8 0 0 0 13.6 5.6l2.4-2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
</svg>
`;

function fmtDate(iso) {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(dt);
}

function fmtClockDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildNowSignature(item) {
  if (!item) {
    return "";
  }
  return [item.track_name || "", item.artists || "", item.album || "", item.external_url || ""].join("|");
}

async function fetchJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });

  if (res.status === 401) {
    return { unauthenticated: true };
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || 1);
    return { rateLimited: true, retryAfter };
  }

  if (!res.ok) {
    throw new Error(`http ${res.status}`);
  }

  return { data: await res.json() };
}

function setStats(items, fetchedAt = null) {
  const count = items.length;
  const artists = new Set();

  for (const item of items) {
    const value = String(item.artists || "");
    for (const artist of value.split(",")) {
      const normalized = artist.trim().toLowerCase();
      if (normalized) {
        artists.add(normalized);
      }
    }
  }

  let latest = null;
  for (const item of items) {
    const stamp = new Date(item.played_at).getTime();
    if (!Number.isNaN(stamp) && (latest === null || stamp > latest)) {
      latest = stamp;
    }
  }

  statTracksEl.textContent = String(count);
  statArtistsEl.textContent = String(artists.size);
  statLastEl.textContent = latest ? fmtDate(new Date(latest).toISOString()) : "none";
  statUpdatedEl.textContent = fetchedAt ? fmtDate(fetchedAt) : "-";
}

function setupRevealObserver() {
  if (!("IntersectionObserver" in window)) {
    for (const el of revealEls) {
      el.classList.add("is-visible");
    }
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
    { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
  );

  for (const el of revealEls) {
    observer.observe(el);
  }
}

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

function setNowProgress(progressMs, durationMs) {
  const safeDuration = Math.max(0, Number(durationMs || 0));
  const safeProgress = Math.min(Math.max(0, Number(progressMs || 0)), safeDuration || Number(progressMs || 0));

  if (!safeDuration) {
    nowProgressEl.textContent = "-";
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

  if (!nowPlaybackState || !nowPlaybackState.isPlaying) {
    return;
  }

  progressTicker = setInterval(() => {
    if (!nowPlaybackState || !nowPlaybackState.isPlaying) {
      stopProgressTicker();
      return;
    }

    const elapsed = Date.now() - nowPlaybackState.anchorAt;
    const nextProgress = nowPlaybackState.anchorProgress + elapsed;
    setNowProgress(nextProgress, nowPlaybackState.duration);
  }, 1000);
}

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
        const cover = item.album_image
          ? `<img class="cover" alt="album cover" src="${escapeHtml(item.album_image)}" loading="lazy" />`
          : `<div class="cover" aria-hidden="true"></div>`;

        const spotifyLink = item.external_url
          ? `<a class="track-link" href="${escapeHtml(item.external_url)}" target="_blank" rel="noreferrer">${spotifyIcon}open in spotify</a>`
          : "";

        return `
          <li class="track" style="--i:${index};">
            ${cover}
            <div class="meta">
              <p class="name">${escapeHtml(item.track_name)}</p>
              <p class="sub">${escapeHtml(item.artists)} • ${escapeHtml(item.album)}</p>
              <p class="sub">played ${escapeHtml(fmtDate(item.played_at))}</p>
              ${spotifyLink}
            </div>
          </li>
        `;
      })
      .join("");

    tracksEl.classList.remove("refreshing");
  }, 180);
}

function renderNowPlaying(data) {
  const item = data?.item;
  const isPlaying = Boolean(data?.is_playing && item);
  const signature = buildNowSignature(item);

  if (signature !== currentNowSignature) {
    nowPanelEl.classList.add("now-changing");
    window.setTimeout(() => nowPanelEl.classList.remove("now-changing"), 520);
  }
  currentNowSignature = signature;

  if (!item) {
    stopProgressTicker();
    nowPlaybackState = null;
    nowCoverEl.removeAttribute("src");
    nowTrackEl.textContent = "nothing right now";
    nowArtistsEl.textContent = "-";
    nowAlbumEl.textContent = "-";
    setNowProgress(0, 0);
    nowLinkEl.classList.add("hidden");
    eqEl.classList.add("off");
    return;
  }

  nowCoverEl.src = item.album_image || "";
  nowTrackEl.textContent = item.track_name || "unknown";
  nowArtistsEl.textContent = item.artists || "unknown";
  nowAlbumEl.textContent = item.album || "unknown";

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
    eqEl.classList.remove("off");
    nowPlaybackState = {
      isPlaying: true,
      anchorAt: Date.now(),
      anchorProgress: progress,
      duration
    };
    startProgressTicker();
  } else {
    eqEl.classList.add("off");
    stopProgressTicker();
    nowPlaybackState = {
      isPlaying: false,
      anchorAt: Date.now(),
      anchorProgress: progress,
      duration
    };
  }
}

function showDisconnected() {
  tracksEl.innerHTML = "";
  stopProgressTicker();
  currentNowSignature = "";
  renderNowPlaying(null);
  setStats([], null);
  statusEl.textContent = "not connected. click connect spotify";
}

function showError() {
  statusEl.textContent = "failed to load data";
}

function setButtonCooldown(seconds = 2.5) {
  cooldownUntil = Date.now() + Math.floor(seconds * 1000);
}

function updateRefreshButton() {
  const remaining = cooldownUntil - Date.now();
  const cooling = remaining > 0;
  refreshBtn.disabled = loadInFlight || cooling;

  if (loadInFlight) {
    refreshBtn.classList.add("loading");
    refreshBtn.innerHTML = `${refreshIcon}loading...`;
    return;
  }

  refreshBtn.classList.remove("loading");

  if (cooling) {
    const sec = Math.max(1, Math.ceil(remaining / 1000));
    refreshBtn.textContent = `wait ${sec}s`;
    return;
  }

  refreshBtn.innerHTML = `${refreshIcon}refresh`;
}

async function loadNowPlaying({ silent = false } = {}) {
  try {
    const result = await fetchJson("/api/now-playing");

    if (result.unauthenticated) {
      if (!silent) {
        showDisconnected();
      }
      return;
    }

    if (result.rateLimited) {
      if (!silent) {
        statusEl.textContent = `slow down: retry in ${result.retryAfter}s`;
      }
      return;
    }

    renderNowPlaying(result.data);
  } catch (error) {
    if (!silent) {
      console.error(error);
    }
  }
}

async function loadAll() {
  if (loadInFlight) {
    return;
  }

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
      fetchJson("/api/now-playing")
    ]);

    if (recentResult.unauthenticated || nowResult.unauthenticated) {
      showDisconnected();
      return;
    }

    if (recentResult.rateLimited || nowResult.rateLimited) {
      const seconds = Math.max(recentResult.retryAfter || 1, nowResult.retryAfter || 1);
      statusEl.textContent = `rate limited, retry in ${seconds}s`;
      setButtonCooldown(seconds);
      return;
    }

    renderTracks(recentResult.data.items || [], recentResult.data.fetched_at || null);
    renderNowPlaying(nowResult.data || null);

    if (nowPlayingTicker) {
      clearInterval(nowPlayingTicker);
    }

    nowPlayingTicker = setInterval(() => {
      loadNowPlaying({ silent: true });
    }, 25_000);
  } catch (error) {
    showError();
    console.error(error);
  } finally {
    loadInFlight = false;
    if (Date.now() >= cooldownUntil) {
      setButtonCooldown(2.5);
    }
    updateRefreshButton();
  }
}

refreshBtn.addEventListener("click", () => {
  loadAll();
});

setupRevealObserver();
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

setInterval(updateRefreshButton, 500);
updateRefreshButton();
loadAll();
