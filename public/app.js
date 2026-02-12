const statusEl = document.getElementById("status");
const tracksEl = document.getElementById("tracks");
const refreshBtn = document.getElementById("refresh");
const statTracksEl = document.getElementById("stat-tracks");
const statArtistsEl = document.getElementById("stat-artists");
const statLastEl = document.getElementById("stat-last");

const spotifyIcon = `
<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
  <path d="m6.5 10.1c3.7-1.1 7.5-.8 10.9.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
  <path d="m7.5 13c2.9-.8 5.8-.6 8.4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
  <path d="m8.6 15.8c2-.5 4-.3 5.7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStats(items) {
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
}

function renderTracks(items) {
  setStats(items);

  if (!items.length) {
    tracksEl.innerHTML = "";
    statusEl.textContent = "no recent tracks found";
    return;
  }

  statusEl.textContent = `showing ${items.length} recent tracks`;

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
}

function showDisconnected() {
  tracksEl.innerHTML = "";
  setStats([]);
  statusEl.textContent = "not connected. click connect spotify";
}

function showError() {
  tracksEl.innerHTML = "";
  setStats([]);
  statusEl.textContent = "failed to load recent tracks";
}

async function loadRecents() {
  statusEl.textContent = "loading...";

  try {
    const res = await fetch("/api/recent", { credentials: "same-origin" });

    if (res.status === 401) {
      showDisconnected();
      return;
    }

    if (!res.ok) {
      throw new Error(`http ${res.status}`);
    }

    const data = await res.json();
    renderTracks(data.items || []);
  } catch (error) {
    showError();
    console.error(error);
  }
}

refreshBtn.addEventListener("click", () => {
  loadRecents();
});

loadRecents();
