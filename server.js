import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const {
  spotify_client_id,
  spotify_client_secret,
  spotify_redirect_uri,
  session_secret,
  port = 3000
} = process.env;

if (!spotify_client_id || !spotify_client_secret || !spotify_redirect_uri || !session_secret) {
  console.error("missing required env vars. check .env.example");
  process.exit(1);
}

const sessionKey = crypto.createHash("sha256").update(session_secret).digest();
const isSecureCookie = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

const apiRateWindowMs = 60_000;
const apiRateLimit = 80;
const rateBuckets = new Map();

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [key, ...rest] = pair.split("=");
      acc[key] = decodeURIComponent(rest.join("="));
      return acc;
    }, {});
}

function toBase64Url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  let input = value.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4 !== 0) {
    input += "=";
  }
  return Buffer.from(input, "base64");
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signValue(value) {
  return toBase64Url(crypto.createHmac("sha256", session_secret).update(value).digest());
}

function makeSignedValue(value) {
  return `${value}.${signValue(value)}`;
}

function readSignedValue(raw) {
  if (!raw) {
    return null;
  }

  const lastDot = raw.lastIndexOf(".");
  if (lastDot <= 0) {
    return null;
  }

  const value = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  const expected = signValue(value);

  if (!timingSafeEqualString(sig, expected)) {
    return null;
  }

  return value;
}

function sealSession(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(toBase64Url).join(".");
}

function unsealSession(token) {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const [iv, tag, ciphertext] = parts.map(fromBase64Url);
    const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function serializeCookie(name, value, options = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || "/"}`, "SameSite=Lax"];

  if (options.httpOnly !== false) {
    attrs.push("HttpOnly");
  }

  if (options.maxAge !== undefined) {
    attrs.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  if (options.secure) {
    attrs.push("Secure");
  }

  return attrs.join("; ");
}

function setCookies(res, cookies) {
  res.setHeader("Set-Cookie", cookies);
}

function randomString(len = 24) {
  return toBase64Url(crypto.randomBytes(len));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getTokenFromCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: spotify_redirect_uri
  });

  const basic = Buffer.from(`${spotify_client_id}:${spotify_client_secret}`).toString("base64");

  const res = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`spotify token error: ${res.status} ${text}`);
  }

  return res.json();
}

async function refreshToken(refreshTokenValue) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue
  });

  const basic = Buffer.from(`${spotify_client_id}:${spotify_client_secret}`).toString("base64");

  const res = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`spotify refresh error: ${res.status} ${text}`);
  }

  return res.json();
}

async function spotifyGet(url, accessToken, options = {}) {
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (options.allowNoContent && res.status === 204) {
    return null;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`spotify api error: ${res.status} ${text}`);
  }

  return res.json();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function applyRateLimit(req, res, next) {
  const now = Date.now();
  const ip = getClientIp(req);
  const bucket = rateBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, {
      count: 1,
      resetAt: now + apiRateWindowMs
    });
    return next();
  }

  if (bucket.count >= apiRateLimit) {
    const retrySeconds = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(Math.max(1, retrySeconds)));
    return res.status(429).json({ error: "too_many_requests" });
  }

  bucket.count += 1;
  return next();
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return unsealSession(cookies.sp_session);
}

function writeSessionCookie(res, payload) {
  const token = sealSession(payload);
  const cookie = serializeCookie("sp_session", token, {
    maxAge: 60 * 60 * 24 * 30,
    secure: isSecureCookie
  });
  setCookies(res, [cookie]);
}

function clearSessionCookies(res) {
  const sessionCookie = serializeCookie("sp_session", "", {
    maxAge: 0,
    secure: isSecureCookie
  });
  const stateCookie = serializeCookie("sp_oauth_state", "", {
    maxAge: 0,
    secure: isSecureCookie
  });
  setCookies(res, [sessionCookie, stateCookie]);
}

async function ensureAccess(req, res) {
  let session = getSessionFromRequest(req);

  if (!session?.access_token) {
    return { error: "not_authenticated" };
  }

  let accessToken = session.access_token;
  let refreshTokenValue = session.refresh_token;
  let expiresAt = Number(session.expires_at || 0);

  if (Date.now() >= expiresAt - 30_000) {
    if (!refreshTokenValue) {
      clearSessionCookies(res);
      return { error: "not_authenticated" };
    }

    try {
      const refreshed = await refreshToken(refreshTokenValue);
      accessToken = refreshed.access_token;
      refreshTokenValue = refreshed.refresh_token || refreshTokenValue;
      expiresAt = Date.now() + refreshed.expires_in * 1000;

      session = {
        ...session,
        access_token: accessToken,
        refresh_token: refreshTokenValue,
        expires_at: expiresAt
      };

      writeSessionCookie(res, session);
    } catch (error) {
      clearSessionCookies(res);
      throw error;
    }
  }

  return { accessToken };
}

app.use(express.static(publicDir));
app.use("/api", applyRateLimit);

app.get("/api/login", (req, res) => {
  const state = randomString(18);
  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", spotify_client_id);
  authUrl.searchParams.set("scope", "user-read-recently-played user-read-currently-playing");
  authUrl.searchParams.set("redirect_uri", spotify_redirect_uri);
  authUrl.searchParams.set("state", state);

  if (String(req.query.switch || "") === "1") {
    authUrl.searchParams.set("show_dialog", "true");
  }

  const stateCookie = serializeCookie("sp_oauth_state", makeSignedValue(state), {
    maxAge: 60 * 10,
    secure: isSecureCookie
  });

  setCookies(res, [stateCookie]);
  res.redirect(authUrl.toString());
});

app.get("/api/callback", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const cookieState = readSignedValue(cookies.sp_oauth_state);
    const { code, state } = req.query;

    if (!cookieState || !code || !state || !timingSafeEqualString(cookieState, String(state))) {
      return res.status(400).send("invalid auth callback");
    }

    const tokenData = await getTokenFromCode(String(code));

    const sessionPayload = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000
    };

    const sessionCookie = serializeCookie("sp_session", sealSession(sessionPayload), {
      maxAge: 60 * 60 * 24 * 30,
      secure: isSecureCookie
    });

    const clearState = serializeCookie("sp_oauth_state", "", {
      maxAge: 0,
      secure: isSecureCookie
    });

    setCookies(res, [sessionCookie, clearState]);
    return res.redirect("/");
  } catch (error) {
    console.error(error);
    return res.status(500).send("spotify auth failed");
  }
});

app.get("/api/recent", async (req, res) => {
  try {
    const auth = await ensureAccess(req, res);
    if (auth.error) {
      return res.status(401).json({ error: auth.error });
    }

    const recent = await spotifyGet(
      "https://api.spotify.com/v1/me/player/recently-played?limit=20",
      auth.accessToken
    );

    const items = (recent.items || []).map((item) => ({
      played_at: item.played_at,
      track_name: item.track?.name || "unknown",
      artists: (item.track?.artists || []).map((a) => a.name).join(", "),
      album: item.track?.album?.name || "unknown",
      album_image: item.track?.album?.images?.[1]?.url || item.track?.album?.images?.[0]?.url || null,
      external_url: item.track?.external_urls?.spotify || null,
      duration_ms: item.track?.duration_ms || 0
    }));

    res.setHeader("Cache-Control", "private, no-store");
    return res.json({ items, fetched_at: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "failed_to_fetch_recent_tracks" });
  }
});

app.get("/api/now-playing", async (req, res) => {
  try {
    const auth = await ensureAccess(req, res);
    if (auth.error) {
      return res.status(401).json({ error: auth.error });
    }

    const payload = await spotifyGet(
      "https://api.spotify.com/v1/me/player/currently-playing",
      auth.accessToken,
      { allowNoContent: true }
    );

    if (!payload?.item) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ is_playing: false, item: null });
    }

    const item = payload.item;
    const out = {
      is_playing: Boolean(payload.is_playing),
      progress_ms: payload.progress_ms || 0,
      item: {
        track_name: item.name || "unknown",
        artists: (item.artists || []).map((a) => a.name).join(", "),
        album: item.album?.name || "unknown",
        album_image: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || null,
        external_url: item.external_urls?.spotify || null,
        duration_ms: item.duration_ms || 0
      }
    };

    res.setHeader("Cache-Control", "private, no-store");
    return res.json(out);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "failed_to_fetch_now_playing" });
  }
});

app.get("/api/logout", (req, res) => {
  clearSessionCookies(res);
  res.redirect("/");
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

if (!process.env.VERCEL) {
  app.listen(Number(port), () => {
    console.log(`server running on http://localhost:${port}`);
  });
}

export default app;
