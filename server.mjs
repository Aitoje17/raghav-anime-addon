// Generated from the tested source modules by scripts/bundle.mjs.

import http from "node:http";

const manifest = {
  id: "community.raghav.anime",
  version: "1.0.0",
  name: "Raghav Anime",
  description: "Aggregated SUB and DUB anime streams for Stremio and Nuvio",
  logo: "https://www.pngall.com/wp-content/uploads/13/Anime-Logo-PNG-Images.png",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
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
  const streams = [];
  for (const result of audioResults.filter(Boolean)) {
    for (const server of result.items) {
      let url = server.stream;
      if (server.type === "embed") {
        const provider = String(server.embed || "").match(/[?&]server=([^&]+)/)?.[1] || "kari";
        try { url = await resolveVidhawk(media, result.audio, provider); } catch { url = null; }
      } else if (url?.startsWith("/")) {
        url = `${BASE_URL}${url}`;
      }
      if (!url?.startsWith("http")) continue;
      const label = String(server.label || server.name || "AniChan").replace("★", "").trim();
      const subtitles = (server.subtitles || []).filter((sub) => sub.url?.startsWith("http")).map((sub, index) => ({
        id: `anichan-${index}-${sub.lang || "subtitle"}`,
        url: sub.url,
        lang: String(sub.lang || "und").slice(0, 3).toLowerCase()
      }));
      streams.push({
        name: `Raghav Anime\nAniChan ${result.audio.toUpperCase()}`,
        title: `${label} • ${result.audio.toUpperCase()}`,
        url,
        subtitles,
        behaviorHints: {
          bingeGroup: `raghav-anichan-${result.audio}`,
          notWebReady: false,
          proxyHeaders: { request: { Referer: `${BASE_URL}/`, "User-Agent": USER_AGENT } }
        }
      });
    }
  }
  return streams;
}

})();


const providers = [getAniNamiStreams, getAniChanStreams];

async function getStreams(type, id) {
  const media = await resolveMedia(type, id);
  if (!media) return [];
  const settled = await Promise.allSettled(providers.map((provider) => provider(media)));
  const streams = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const seen = new Set();
  return streams.filter((stream) => stream.url && !seen.has(stream.url) && seen.add(stream.url));
}



const port = Number(process.env.PORT || 7000);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "cache-control": status === 200 ? "public, max-age=300" : "no-store"
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return json(response, 200, {});
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/manifest.json") return json(response, 200, manifest);
  if (url.pathname === "/health") return json(response, 200, { ok: true });

  const match = url.pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
  if (match) {
    try {
      return json(response, 200, { streams: await getStreams(match[1], match[2]) });
    } catch (error) {
      console.error("stream request failed", error);
      return json(response, 200, { streams: [] });
    }
  }

  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(`<!doctype html><title>Raghav Anime</title><h1>Raghav Anime</h1><p>Stremio/Nuvio addon is running.</p><p><a href="stremio://${request.headers.host}/manifest.json">Install in Stremio</a></p>`);
  }
  return json(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => console.log(`Raghav Anime addon listening on http://0.0.0.0:${port}`));
