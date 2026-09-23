// Generated from the tested source modules by scripts/bundle.mjs.

import http from "node:http";

import https from "node:https";

import { createHmac, randomBytes, timingSafeEqual, createHash, createDecipheriv, pbkdf2Sync } from "node:crypto";

import { Readable } from "node:stream";

const manifest = {
  id: "community.raghav.anime",
  version: "1.3.2",
  name: "Raghav Anime",
  description: "Aggregated SUB and DUB anime streams for Stremio and Nuvio",
  logo: "https://www.pngall.com/wp-content/uploads/13/Anime-Logo-PNG-Images.png",
  resources: ["stream", "subtitles"],
  types: ["movie", "series", "anime"],
  idPrefixes: ["tt", "kitsu:", "anilist:", "mal:", "tmdb:"],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};


const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return response.json();
}

async function settleWithConcurrency(tasks, concurrency = 8) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = await tasks[index]();
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}



const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

function normalizeTitle(value = "") {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x === y) return 1;
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const xs = new Set(x.split(" "));
  const ys = new Set(y.split(" "));
  const intersection = [...xs].filter((word) => ys.has(word)).length;
  return intersection / Math.max(xs.size, ys.size);
}

function parseStremioId(type, rawId) {
  const [imdbId, seasonRaw, episodeRaw] = decodeURIComponent(rawId).split(":");
  if (!/^tt\d+$/.test(imdbId)) return null;
  if (type === "movie") return { imdbId, season: null, episode: 1 };
  const season = Number(seasonRaw);
  const episode = Number(episodeRaw);
  if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 1) return null;
  return { imdbId, season, episode };
}

async function getCinemeta(type, imdbId) {
  const key = `cinemeta:${type}:${imdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const metaType = type === "movie" ? "movie" : "series";
  const response = await fetchJson(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`);
  return cacheSet(key, response.meta);
}

function seasonYear(meta, season) {
  if (season == null) return Number(String(meta.releaseInfo || "").match(/\d{4}/)?.[0]) || null;
  const video = meta.videos?.find((item) => Number(item.season) === season && item.firstAired);
  return Number(String(video?.firstAired || "").slice(0, 4)) || null;
}

async function getTmdbSeason(meta, season) {
  if (!meta.moviedb_id || !season) return null;
  const key = `tmdb-season:${meta.moviedb_id}:${season}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const apiKey = process.env.TMDB_API_KEY || "e6333b32409e02a4a6eba6fb7ff866bb";
  try {
    const value = await fetchJson(
      `https://api.themoviedb.org/3/tv/${meta.moviedb_id}/season/${season}?api_key=${apiKey}&language=en-US`
    );
    return cacheSet(key, value);
  } catch {
    return null;
  }
}

const ANILIST_QUERY = `
  query ($search: String!) {
    Page(page: 1, perPage: 20) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        idMal
        format
        seasonYear
        episodes
        title { romaji english native }
      }
    }
  }
`;

async function aniListSearch(search) {
  const response = await fetchJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { search } })
  });
  return response.data?.Page?.media || [];
}

function candidateScore(media, title, year, season, queryIndex, resultIndex) {
  const names = [media.title?.english, media.title?.romaji, media.title?.native].filter(Boolean);
  const titleScore = Math.max(0, ...names.map((name) => similarity(name, title))) * 100;
  const yearDelta = year && media.seasonYear ? Math.abs(year - media.seasonYear) : null;
  const yearScore = yearDelta == null ? 0 : yearDelta <= 1 ? 40 : -50;
  const seasonQueryScore = season > 1 && queryIndex === 0 ? 80 : 0;
  const orderScore = Math.max(0, 20 - resultIndex);
  return titleScore + yearScore + seasonQueryScore + orderScore;
}

async function resolveMedia(type, rawId) {
  const alternate = await resolveAlternateId(type, rawId);
  if (alternate) return alternate;
  const parsed = parseStremioId(type, rawId);
  if (!parsed) return null;
  const key = `mapping:${type}:${rawId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const meta = await getCinemeta(type, parsed.imdbId);
  const title = meta.name;
  const tmdbSeason = type === "series" ? await getTmdbSeason(meta, parsed.season) : null;
  const seasonTitle = parsed.season > 1 && tmdbSeason?.name && !/^season\s+\d+$/i.test(tmdbSeason.name)
    ? tmdbSeason.name
    : null;
  const mappingTitle = seasonTitle || title;
  const year = Number(String(tmdbSeason?.air_date || "").slice(0, 4)) || seasonYear(meta, parsed.season);
  const queries = parsed.season && parsed.season > 1
    ? [seasonTitle || `${title} Season ${parsed.season}`, title]
    : [title];
  const pages = await Promise.all(queries.map(aniListSearch));
  const ranked = [];
  pages.forEach((items, queryIndex) => items.forEach((media, resultIndex) => {
    ranked.push({ media, score: candidateScore(media, mappingTitle, year, parsed.season || 1, queryIndex, resultIndex) });
  }));
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 65) return null;

  return cacheSet(key, {
    imdbId: parsed.imdbId,
    tmdbId: meta.moviedb_id || null,
    aniListId: best.media.id,
    malId: best.media.idMal || null,
    title: best.media.title?.english || best.media.title?.romaji || title,
    romajiTitle: best.media.title?.romaji || null,
    season: parsed.season,
    episode: parsed.episode,
    year: best.media.seasonYear || year
  });
}

async function resolveAlternateId(type, rawId) {
  const parts = decodeURIComponent(rawId).split(":");
  const prefix = parts[0];
  if (!["kitsu", "anilist", "mal", "tmdb"].includes(prefix) || !/^\d+$/.test(parts[1] || "")) return null;
  const key = `alternate:${type}:${rawId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  let episode;
  let season = 1;
  if (prefix === "tmdb") {
    season = type === "movie" ? 1 : Number(parts[2]);
    episode = type === "movie" ? 1 : Number(parts[3]);
  } else {
    episode = type === "movie" && parts[2] == null ? 1 : Number(parts[2]);
  }
  if (!Number.isInteger(episode) || episode < 1 || !Number.isInteger(season) || season < 0) return null;

  let aniListId;
  let title;
  let year;
  if (prefix === "anilist") {
    aniListId = Number(parts[1]);
  } else if (prefix === "mal") {
    const query = `query ($id: Int!) { Media(idMal: $id, type: ANIME) { id title { english romaji } seasonYear } }`;
    const response = await fetchJson("https://graphql.anilist.co", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { id: Number(parts[1]) } })
    });
    aniListId = response.data?.Media?.id;
    title = response.data?.Media?.title?.english || response.data?.Media?.title?.romaji;
    year = response.data?.Media?.seasonYear;
  } else if (prefix === "kitsu") {
    const response = await fetchJson(`https://kitsu.io/api/edge/anime/${parts[1]}`);
    const attributes = response.data?.attributes;
    title = attributes?.titles?.en || attributes?.canonicalTitle;
    year = Number(attributes?.startDate?.slice(0, 4)) || null;
  } else {
    const apiKey = process.env.TMDB_API_KEY || "e6333b32409e02a4a6eba6fb7ff866bb";
    const kind = type === "movie" ? "movie" : "tv";
    const response = await fetchJson(`https://api.themoviedb.org/3/${kind}/${parts[1]}?api_key=${apiKey}&language=en-US`);
    title = response.name || response.title;
    year = Number((response.first_air_date || response.release_date || "").slice(0, 4)) || null;
    if (type !== "movie" && season > 1) {
      const seasonData = await fetchJson(`https://api.themoviedb.org/3/tv/${parts[1]}/season/${season}?api_key=${apiKey}&language=en-US`);
      if (seasonData.name && !/^season\s+\d+$/i.test(seasonData.name)) title = seasonData.name;
      year = Number((seasonData.air_date || "").slice(0, 4)) || year;
    }
  }
  if (!aniListId && title) {
    const results = await aniListSearch(title);
    results.sort((a, b) => candidateScore(b, title, year, season, 0, 0) - candidateScore(a, title, year, season, 0, 0));
    if (!results[0] || candidateScore(results[0], title, year, season, 0, 0) < 65) return null;
    aniListId = results[0].id;
  }
  if (!aniListId) return null;
  return cacheSet(key, { aniListId, episode, season, title: title || "Anime", year });
}


const getAniNamiStreams = (() => {

const BASE_URL = process.env.ANINAMI_URL || "https://www.aninami.site";
const HEADERS = { accept: "application/json", referer: `${BASE_URL}/`, "user-agent": "Mozilla/5.0" };

function subtitleLanguage(label = "") {
  const value = label.toLowerCase();
  if (value.includes("english")) return "eng";
  if (value.includes("spanish") || value.includes("espa")) return "spa";
  if (value.includes("portugu")) return "por";
  if (value.includes("french") || value.includes("fran")) return "fra";
  if (value.includes("german") || value.includes("deutsch")) return "deu";
  return "und";
}

function toSubtitles(items = []) {
  return items
    .map((item, index) => ({
      id: `aninami-${index}-${item.label || "subtitle"}`,
      url: item.file || item.url,
      lang: subtitleLanguage(item.label)
    }))
    .filter((item) => item.url?.startsWith("http"));
}

return async function getAniNamiStreams(media) {
  const episodeData = await fetchJson(`${BASE_URL}/api/episodes/${media.aniListId}`, { headers: HEADERS });
  const providers = episodeData.results?.providers || {};
  const targets = [];
  for (const [provider, value] of Object.entries(providers)) {
    for (const audio of ["sub", "dub"]) {
      for (const item of value.episodes?.[audio] || []) {
        if (Number(item.number) !== Number(media.episode)) continue;
        const parts = String(item.id || "").split("/");
        if (parts.length < 5 || parts[0] !== "watch") continue;
        targets.push({ provider: parts[1] || provider, aniListId: parts[2], audio: parts[3] || audio, slug: parts.slice(4).join("/") });
      }
    }
  }

  const responses = await settleWithConcurrency(targets.map((target) => async () => {
    const url = `${BASE_URL}/api/watch/${encodeURIComponent(target.provider)}/${target.aniListId}/${target.audio}/${target.slug}`;
    return { target, data: await fetchJson(url, { headers: HEADERS }) };
  }), 10);

  const streams = [];
  for (const response of responses.filter(Boolean)) {
    const subtitles = toSubtitles(response.data.results?.subtitles || []);
    for (const stream of response.data.results?.streams || []) {
      if (!stream.url?.startsWith("http") || !["hls", "mp4", "video"].includes(String(stream.type).toLowerCase())) continue;
      const audio = response.target.audio.toUpperCase();
      const source = response.target.provider;
      const referer = stream.referer || `${BASE_URL}/`;
      streams.push({
        name: `Raghav Anime\n${source} ${audio}`,
        title: `${source} • ${audio} • ${stream.quality || "Auto"}`,
        url: stream.url,
        subtitles,
        behaviorHints: {
          bingeGroup: `raghav-${source}-${audio}`,
          notWebReady: false,
          proxyHeaders: { request: { Referer: referer, "User-Agent": "Mozilla/5.0" } }
        }
      });
    }
  }
  return streams;
}

})();

const getAniChanStreams = (() => {

const BASE_URL = process.env.ANICHAN_URL || "https://anichan.to";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";

async function watchSession() {
  const response = await fetchWithTimeout(`${BASE_URL}/api/watch/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: BASE_URL, "user-agent": USER_AGENT },
    body: JSON.stringify({ token: "" })
  });
  if (!response.ok) return null;
  return response.headers.get("set-cookie")?.match(/anichan_ws=([^;]+)/)?.[1] || null;
}

async function servers(media, audio) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cookie = await watchSession();
    if (!cookie) continue;
    try {
      return (await fetchJson(
        `${BASE_URL}/api/watch/servers?anilistId=${media.aniListId}&ep=${media.episode}&category=${audio}`,
        { headers: { accept: "application/json", cookie: `anichan_ws=${cookie}`, "user-agent": USER_AGENT } }
      )).servers || [];
    } catch {}
  }
  return [];
}

async function resolveVidhawk(media, audio, server) {
  const headers = { referer: `${BASE_URL}/`, "user-agent": USER_AGENT };
  const race = await fetchJson(
    `https://vidhawk.buzz/api/stream/race?episode=${media.episode}&audio=${audio}&server=${encodeURIComponent(server)}&anilistId=${media.aniListId}&parentHost=anichan.to`,
    { headers }
  );
  const ticket = race.servers?.find((item) => String(item.id).toLowerCase() === server.toLowerCase())?.ticket || race.ticket;
  if (!ticket) return null;
  const play = await fetchJson(`https://vidhawk.buzz/api/play?t=${encodeURIComponent(ticket)}`, { headers });
  return play.tracks?.find((track) => String(track.id).toLowerCase() === audio && track.src?.startsWith("http"))?.src || null;
}

return async function getAniChanStreams(media) {
  const audioResults = await settleWithConcurrency(["sub", "dub"].map((audio) => async () => ({ audio, items: await servers(media, audio) })), 2);
  const targets = audioResults.filter(Boolean).flatMap((result) => result.items.map((server) => ({ audio: result.audio, server })));
  const resolved = await settleWithConcurrency(targets.map(({ audio, server }) => async () => {
      let url = server.stream;
      if (server.type === "embed") {
        const provider = String(server.embed || "").match(/[?&]server=([^&]+)/)?.[1] || "kari";
        try { url = await resolveVidhawk(media, audio, provider); } catch { url = null; }
      } else if (url?.startsWith("/")) {
        url = `${BASE_URL}${url}`;
      }
      if (!url?.startsWith("http")) return null;
      const label = String(server.label || server.name || "AniChan").replace("★", "").trim();
      const subtitles = (server.subtitles || []).filter((sub) => sub.url?.startsWith("http")).map((sub, index) => ({
        id: `anichan-${index}-${sub.lang || "subtitle"}`,
        url: sub.url,
        lang: String(sub.lang || "und").slice(0, 3).toLowerCase()
      }));
      return {
        name: `Raghav Anime\nAniChan ${audio.toUpperCase()}`,
        title: `${label} • ${audio.toUpperCase()}`,
        url,
        subtitles,
        behaviorHints: {
          bingeGroup: `raghav-anichan-${audio}`,
          notWebReady: false,
          proxyHeaders: { request: { Referer: `${BASE_URL}/`, "User-Agent": USER_AGENT } }
        }
      };
  }), 8);
  return resolved.filter(Boolean);
}

})();

const getReAnimeStreams = (() => {

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

function nativeJson(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { ...headers, "accept-encoding": "identity" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTPS ${response.statusCode} from reanime.to (${response.headers.server || "unknown server"}; ${response.headers["cf-mitigated"] || "no challenge header"}; ${body.slice(0, 80).replace(/\s+/g, " ")})`));
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("ReAnime HTTPS timeout")));
    request.on("error", reject);
  });
}

async function reanimeJson(url, headers) {
  const response = await fetchWithTimeout(url, { headers });
  if (response.ok) return response.json();
  if (response.status !== 403) throw new Error(`${response.status} from reanime.to`);
  try {
    return await nativeJson(url, headers);
  } catch (error) {
    throw new Error(`ReAnime fetch 403; ${error.message}`);
  }
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shaChain(seed) {
  let value = seed;
  for (let index = 0; index < 3; index++) value = sha(value + index);
  return value;
}

function field(source, key) {
  return source.match(new RegExp(`"?${key}"?\\s*:\\s*"([^"]+)"`))?.[1] || null;
}

function subtitleLanguage(value = "") {
  const language = value.toLowerCase();
  if (language.startsWith("en")) return "eng";
  if (language.startsWith("es")) return "spa";
  if (language.startsWith("pt")) return "por";
  if (language.startsWith("fr")) return "fra";
  if (language.startsWith("de")) return "deu";
  if (language.startsWith("ja")) return "jpn";
  return language.length === 3 ? language : "und";
}

function extractSubtitles(region) {
  const list = region.match(/subtitles:\[([^\]]*)\]/)?.[1] || "";
  return [...list.matchAll(/\{([^{}]*)\}/g)].flatMap((match, index) => {
    const url = field(match[1], "url");
    if (!url?.startsWith("http")) return [];
    const language = field(match[1], "language") || "Subtitle";
    return [{ id: `reanime-${index}`, url, lang: subtitleLanguage(language), label: `ReAnime • ${language}` }];
  });
}

function dataBytes(wasm) {
  function leb(index) {
    let value = 0;
    let shift = 0;
    while (index < wasm.length) {
      const byte = wasm[index++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return [value, index];
  }
  let index = 8;
  let largest = Buffer.alloc(0);
  while (index < wasm.length) {
    const section = wasm[index++];
    const [size, start] = leb(index);
    const end = start + size;
    if (section === 11) {
      let cursor = start;
      const [count, afterCount] = leb(cursor);
      cursor = afterCount;
      for (let item = 0; item < count; item++) {
        cursor++; // active segment flag
        if (wasm[cursor++] !== 0x41) return null;
        [, cursor] = leb(cursor); // offset
        if (wasm[cursor++] !== 0x0b) return null;
        const [length, afterLength] = leb(cursor);
        cursor = afterLength;
        if (length > largest.length) largest = wasm.subarray(cursor, cursor + length);
        cursor += length;
      }
    }
    index = end;
  }
  return largest.length >= 64 ? largest : null;
}

function decryptPlaylist(body, key) {
  const trimmed = body.trim();
  if (trimmed.startsWith("#EXTM3U")) return trimmed;
  const raw = Buffer.from(trimmed, "base64");
  const plain = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) plain[i] = raw[i] ^ key[i % key.length];
  const text = plain.toString();
  return text.startsWith("#EXTM3U") ? text : null;
}

async function resolveEmbed(embedUrl) {
  const pageHeaders = { "user-agent": USER_AGENT, referer: `${BASE}/` };
  const pageResponse = await fetchWithTimeout(embedUrl, { headers: pageHeaders });
  if (!pageResponse.ok) throw new Error(`embed HTTP ${pageResponse.status}`);
  const region = (await pageResponse.text()).split("node_ids")[1];
  if (!region) throw new Error("embed missing node_ids");
  const seed = field(region, "obfuscation_seed");
  const payload = field(region, "w_payload");
  if (!seed || !payload) throw new Error("embed missing cipher fields");
  const first = shaChain(seed);
  const second = shaChain(first);
  const keyFragment = field(region, `kf_${first.slice(8, 16)}`);
  const iv = field(region, `ivf_${first.slice(16, 24)}`);
  const token = field(region, `${first.slice(48, 64)}_${first.slice(56, 64)}`);
  const keyFragment2 = field(region, `${second.slice(0, 16)}_${second.slice(16, 24)}`);
  if (!keyFragment || !iv || !token || !keyFragment2) throw new Error("embed missing key fields");

  const tokenResponse = await fetchWithTimeout(`${FLIX}/api/m3u8/${token}`, { headers: pageHeaders });
  if (!tokenResponse.ok) throw new Error(`m3u8 API HTTP ${tokenResponse.status}`);
  const tokenBody = await tokenResponse.text();
  const encryptedVideo = field(tokenBody, sha(token + "vid").slice(0, 10));
  const encryptedKey = field(tokenBody, sha(token + "key").slice(0, 10));
  if (!encryptedVideo || !encryptedKey) throw new Error("m3u8 API missing video or key");

  const wasm = Buffer.from(payload, "base64");
  const { instance } = await WebAssembly.instantiate(wasm);
  const fragment1 = Buffer.from(keyFragment, "base64");
  const fragment2 = Buffer.from(keyFragment2, "base64");
  const encryptedKeyBytes = Buffer.from(encryptedKey, "base64");
  const length = fragment1.length;
  if (!length || fragment2.length !== length || encryptedKeyBytes.length !== length) throw new Error("cipher fragment length mismatch");
  const memory = new Uint8Array(instance.exports.memory.buffer);
  const base = 1000;
  memory.set(fragment1, base);
  memory.set(fragment2, base + length);
  memory.set(encryptedKeyBytes, base + 2 * length);
  instance.exports._s(parseInt(seed.slice(0, 8), 16) | 0);
  instance.exports._r(base, base + length, base + 2 * length, base + 3 * length, length);
  const keySeed = Buffer.from(memory.slice(base + 3 * length, base + 4 * length));
  if (keySeed.every((byte) => byte === 0)) throw new Error("cipher produced empty key");

  const seedBytes = Buffer.from(seed);
  const derived = pbkdf2Sync(keySeed, seedBytes, 1000, 32, "sha256");
  for (let i = 0; i < derived.length; i++) derived[i] ^= seedBytes[i % seedBytes.length];
  const aesKey = createHash("sha256").update(derived).digest();
  const decipher = createDecipheriv("aes-256-cbc", aesKey, Buffer.from(iv, "base64"));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedVideo, "base64")), decipher.final()]);
  const padding = decrypted.at(-1);
  const masterUrl = decrypted.subarray(0, padding >= 1 && padding <= 16 ? -padding : undefined).toString().trim();
  if (!masterUrl.startsWith("http")) throw new Error("cipher produced invalid master URL");
  const keyData = dataBytes(wasm);
  if (!keyData) throw new Error("WASM missing playlist key data");
  const playlistKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) playlistKey[i] = keyData[i] ^ keyData[i + 32];
  const masterResponse = await fetchWithTimeout(masterUrl, { headers: { "user-agent": USER_AGENT, referer: `${FLIX}/` } });
  if (!masterResponse.ok) throw new Error(`master playlist HTTP ${masterResponse.status}`);
  const master = decryptPlaylist(await masterResponse.text(), playlistKey);
  if (!master) throw new Error("master playlist decryption failed");
  return { url: masterUrl, key: playlistKey.toString("base64"), master, subtitles: extractSubtitles(region) };
}

return async function getReAnimeStreams(media) {
  const result = await reanimeJson(`${BASE}/api/flix/${media.aniListId}/${media.episode}`, {
    "user-agent": USER_AGENT, accept: "application/json", referer: `${BASE}/watch/`
  });
  const servers = [...new Map((result.servers || [])
    .filter((item) => item.dataLink?.startsWith("http"))
    .map((item) => [item.dataLink, item])).values()];
  if (!servers.length) throw new Error("ReAnime API returned no playable servers");
  const resolved = await settleWithConcurrency(servers.map((server) => async () => {
    try {
      return { server, playback: await resolveEmbed(server.dataLink) };
    } catch (error) {
      return { server, error: String(error?.message || error) };
    }
  }), 3);
  const playable = resolved.filter((item) => item?.playback);
  if (!playable.length) {
    const reasons = [...new Set(resolved.map((item) => item?.error).filter(Boolean))].join("; ");
    throw new Error(`ReAnime embeds could not be resolved (${servers.length} servers): ${reasons || "unknown reason"}`);
  }
  return playable.map(({ server, playback }) => ({
    name: "Raghav Anime\nReAnime",
    title: `ReAnime • ${server.serverName || "HD"} • Multi-Audio`,
    url: playback.url,
    flixKey: playback.key,
    subtitles: playback.subtitles,
    behaviorHints: {
      bingeGroup: "raghav-reanime",
      notWebReady: false,
      proxyHeaders: { request: { Referer: `${FLIX}/`, "User-Agent": USER_AGENT } }
    }
  }));
}

})();


const providers = [getAniNamiStreams, getAniChanStreams, getReAnimeStreams];
const streamCache = new Map();
const streamPending = new Map();
const streamDiagnostics = new Map();
const streamCacheMs = 90 * 1000;

async function getStreams(type, id) {
  const key = `${type}:${id}`;
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.time < streamCacheMs) return hit.streams;
  if (streamPending.has(key)) return streamPending.get(key);
  const task = collectStreams(type, id).then((streams) => {
    streamCache.set(key, { time: Date.now(), streams });
    if (streamCache.size > 200) streamCache.delete(streamCache.keys().next().value);
    return streams;
  }).finally(() => streamPending.delete(key));
  streamPending.set(key, task);
  return task;
}

async function collectStreams(type, id) {
  const media = await resolveMedia(type, id);
  if (!media) return [];
  const settled = await Promise.allSettled(providers.map((provider) => provider(media)));
  streamDiagnostics.set(`${type}:${id}`, settled.map((result, index) => ({
    provider: providers[index].name,
    streams: result.status === "fulfilled" ? result.value.length : 0,
    error: result.status === "rejected" ? String(result.reason?.message || result.reason) : null
  })));
  if (streamDiagnostics.size > 200) streamDiagnostics.delete(streamDiagnostics.keys().next().value);
  settled.forEach((result, index) => {
    if (result.status === "rejected") console.error(`${providers[index].name} failed`, result.reason);
  });
  const streams = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const seen = new Set();
  return streams.filter((stream) => stream.url && !seen.has(stream.url) && seen.add(stream.url));
}

function getStreamDiagnostics(type, id) {
  return streamDiagnostics.get(`${type}:${id}`) || [];
}



const secret = process.env.PROXY_SECRET || randomBytes(32).toString("hex");
const lifetimeMs = 6 * 60 * 60 * 1000;

function publicBase(request) {
  const proto = request.headers["x-forwarded-proto"]?.split(",")[0] || "http";
  const host = request.headers["x-forwarded-host"]?.split(",")[0] || request.headers.host;
  return process.env.PUBLIC_URL || `${proto}://${host}`;
}

function sign(value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function filenameFor(url, kind) {
  if (kind === "subtitle") return "subtitle.vtt";
  const path = new URL(url).pathname.toLowerCase();
  if (/\.mp4$/.test(path)) return "video.mp4";
  if (kind === "stream" || /\.m3u8$/.test(path) || /\/m3u8$/.test(path)) return "master.m3u8";
  if (/\.vtt$/.test(path)) return "subtitle.vtt";
  if (/\.m4s$/.test(path)) return "segment.m4s";
  if (/\.(?:key|bin)$/.test(path)) return "key.bin";
  return "segment.ts";
}

function proxyUrl(request, url, headers = {}, expires = Date.now() + lifetimeMs, kind, flixKey) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported stream URL");
  const filename = filenameFor(target.href, kind);
  const payload = Buffer.from(JSON.stringify({ url: target.href, headers, expires, filename, flixKey })).toString("base64url");
  return `${publicBase(request).replace(/\/$/, "")}/play/${payload}.${sign(payload)}/${filename}`;
}

function decode(token) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() > value.expires || !["http:", "https:"].includes(new URL(value.url).protocol)) return null;
    return value;
  } catch {
    return null;
  }
}

function rewritePlaylist(body, upstreamUrl, request, headers, expires, flixKey) {
  const wrap = (path) => proxyUrl(request, new URL(path, upstreamUrl).href, headers, expires, undefined, flixKey);
  return body.split(/\r?\n/).map((line) => {
    if (line.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_, path) => `URI="${wrap(path)}"`);
    }
    return line.trim() ? wrap(line.trim()) : line;
  }).join("\n");
}

function decryptFlixPlaylist(body, encodedKey) {
  const trimmed = body.trim();
  if (trimmed.startsWith("#EXTM3U")) return trimmed;
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) return null;
  const raw = Buffer.from(trimmed, "base64");
  const plain = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index++) plain[index] = raw[index] ^ key[index % key.length];
  const text = plain.toString();
  return text.startsWith("#EXTM3U") ? text : null;
}

function decodeFlixSegment(raw) {
  let header = 0;
  if (raw.subarray(0, 4).toString() === "RIFF" && raw.subarray(8, 12).toString() === "WEBP") header = 12;
  else if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) header = 8;
  const data = Buffer.from(raw.subarray(header));
  if (header && data[0] !== 0x47) {
    const xor = Buffer.from([157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197]);
    for (let index = 0; index < data.length; index++) data[index] ^= xor[index & 15];
  }
  return data;
}

function subtitleVtt(body) {
  const text = body.replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("WEBVTT")) return text;
  if (text.startsWith("[Script Info]")) {
    const events = text.split(/\[Events\]/i)[1];
    if (!events) return null;
    const formatLine = events.match(/^Format:\s*(.+)$/im)?.[1];
    if (!formatLine) return null;
    const columns = formatLine.split(",").map((item) => item.trim().toLowerCase());
    const startIndex = columns.indexOf("start");
    const endIndex = columns.indexOf("end");
    const textIndex = columns.indexOf("text");
    if (startIndex < 0 || endIndex < 0 || textIndex !== columns.length - 1) return null;
    const timestamp = (value) => {
      const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
      return match ? `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${match[4]}0` : null;
    };
    const cues = [];
    for (const line of events.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.slice(9).split(",");
      if (parts.length < columns.length) continue;
      const start = timestamp(parts[startIndex]);
      const end = timestamp(parts[endIndex]);
      const caption = parts.slice(textIndex).join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " ")
        .trim();
      if (start && end && caption) cues.push(`${start} --> ${end}\n${caption}`);
    }
    return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}` : null;
  }
  if (/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(text)) {
    return `WEBVTT\n\n${text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
  }
  return null;
}

function sendMediaBytes(request, response, bytes, type) {
  const common = {
    "content-type": type,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
    "accept-ranges": "bytes"
  };
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
    const end = range[2] && range[1] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
      response.writeHead(416, { ...common, "content-range": `bytes */${bytes.length}` });
      return response.end();
    }
    response.writeHead(206, {
      ...common,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${bytes.length}`
    });
    return response.end(bytes.subarray(start, end + 1));
  }
  response.writeHead(200, { ...common, "content-length": bytes.length });
  return response.end(bytes);
}

async function handleProxyRequest(request, response, token) {
  const item = decode(token);
  if (!item) {
    response.writeHead(403);
    return response.end("Invalid or expired playback link");
  }
  try {
    const headers = { ...item.headers };
    if (request.headers.range && !item.flixKey && !/^(?:segment\.ts|segment\.m4s)$/.test(item.filename)) headers.range = request.headers.range;
    const upstream = await fetchWithTimeout(item.url, { headers }, 25000);
    if (!upstream.ok && upstream.status !== 206) {
      response.writeHead(upstream.status);
      return response.end("Upstream playback failed");
    }
    let type = upstream.headers.get("content-type") || "application/octet-stream";
    if (item.filename === "subtitle.vtt") {
      const body = subtitleVtt(await upstream.text());
      if (!body) {
        response.writeHead(502, { "access-control-allow-origin": "*" });
        return response.end("Unsupported subtitle format");
      }
      const bytes = Buffer.from(body);
      response.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "content-length": bytes.length,
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS"
      });
      return response.end(bytes);
    }
    const playlist = /mpegurl|m3u8/i.test(type) || /\.m3u8$/i.test(new URL(upstream.url).pathname) || item.filename?.endsWith(".m3u8");
    if (playlist) {
      const raw = await upstream.text();
      const plain = item.flixKey ? decryptFlixPlaylist(raw, item.flixKey) : raw;
      if (!plain?.startsWith("#EXTM3U")) {
        response.writeHead(502, { "access-control-allow-origin": "*" });
        return response.end("Invalid upstream playlist");
      }
      const body = rewritePlaylist(plain, upstream.url, request, item.headers, item.expires, item.flixKey);
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "cache-control": "no-store"
      });
      return response.end(body);
    }
    if (item.flixKey) {
      if (item.filename === "key.bin") {
        const key = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": key.length,
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS"
        });
        return response.end(key);
      }
      const decoded = decodeFlixSegment(Buffer.from(await upstream.arrayBuffer()));
      return sendMediaBytes(request, response, decoded, "video/mp2t");
    }
    if (type.startsWith("image/jpeg") && /\/seg-[^/]+\.jpg$/i.test(new URL(upstream.url).pathname)) type = "video/mp2t";
    if (/^(?:segment\.ts|segment\.m4s)$/.test(item.filename)) {
      return sendMediaBytes(request, response, Buffer.from(await upstream.arrayBuffer()), type);
    }
    const forwarded = { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "accept-ranges": "bytes" };
    for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(key);
      if (value) forwarded[key] = value;
    }
    response.writeHead(upstream.status, forwarded);
    if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
    else response.end();
  } catch (error) {
    console.error("playback proxy failed", error);
    if (!response.headersSent) response.writeHead(502);
    response.end("Playback source unavailable");
  }
}

function prepareStreams(request, streams) {
  return streams.map((stream) => {
    const { flixKey, ...publicStream } = stream;
    const headers = stream.behaviorHints?.proxyHeaders?.request || {};
    try {
      return {
        ...publicStream,
        url: proxyUrl(request, stream.url, headers, undefined, "stream", flixKey),
        subtitles: stream.subtitles?.map((subtitle) => ({
          ...subtitle,
          url: proxyUrl(request, subtitle.url, headers, undefined, "subtitle")
        })),
        behaviorHints: { ...stream.behaviorHints, notWebReady: false, proxyHeaders: undefined }
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function prepareSubtitles(request, streams) {
  const seen = new Set();
  return streams.flatMap((stream, streamIndex) => {
    const headers = stream.behaviorHints?.proxyHeaders?.request || {};
    return (stream.subtitles || []).flatMap((subtitle, subtitleIndex) => {
      if (!subtitle.url || seen.has(subtitle.url)) return [];
      seen.add(subtitle.url);
      try {
        return [{
          id: `raghav-${streamIndex}-${subtitleIndex}`,
          lang: subtitle.lang || "und",
          label: `${stream.title || "Raghav Anime"} • ${subtitle.lang || "Subtitle"}`,
          url: proxyUrl(request, subtitle.url, headers, undefined, "subtitle")
        }];
      } catch {
        return [];
      }
    });
  });
}



const port = Number(process.env.PORT || 7000);

function json(response, status, body, cache = true) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "cache-control": status === 200 && cache ? "public, max-age=300" : "no-store"
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return json(response, 200, {});
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/manifest.json") return json(response, 200, manifest);
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  const playback = url.pathname.match(/^\/play\/([^/]+)\/[^/]+$/);
  if (playback) return handleProxyRequest(request, response, playback[1]);

  const match = url.pathname.match(/^\/stream\/(movie|series|anime)\/(.+)\.json$/);
  if (match) {
    try {
      const streams = prepareStreams(request, await getStreams(match[1], match[2]));
      const body = { streams };
      if (url.searchParams.get("debug") === "1") body.diagnostics = getStreamDiagnostics(match[1], match[2]);
      return json(response, 200, body, false);
    } catch (error) {
      console.error("stream request failed", error);
      return json(response, 200, { streams: [] }, false);
    }
  }

  const subtitleMatch = url.pathname.match(/^\/subtitles\/(movie|series|anime)\/([^/]+)(?:\/[^/]+)?\.json$/);
  if (subtitleMatch) {
    try {
      return json(response, 200, { subtitles: prepareSubtitles(request, await getStreams(subtitleMatch[1], subtitleMatch[2])) }, false);
    } catch (error) {
      console.error("subtitle request failed", error);
      return json(response, 200, { subtitles: [] }, false);
    }
  }

  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(`<!doctype html><title>Raghav Anime</title><h1>Raghav Anime</h1><p>Stremio/Nuvio addon is running.</p><p><a href="stremio://${request.headers.host}/manifest.json">Install in Stremio</a></p>`);
  }
  return json(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => console.log(`Raghav Anime addon listening on http://0.0.0.0:${port}`));
