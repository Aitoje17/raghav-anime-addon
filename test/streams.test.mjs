import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac } from "node:crypto";
import { once } from "node:events";
import { server, getAniChanStreams } from "../server.mjs";

test("AniChan current API and add-on playback", async (t) => {
  const originalFetch = globalThis.fetch;
  const first = Buffer.alloc(32, 17);
  const second = Buffer.alloc(32, 35);
  const nonce = "fixture-session-nonce";
  const sharedKey = Buffer.from(first.map((byte, index) => byte ^ second[index]));
  const key = createHmac("sha256", sharedKey).update(nonce).digest();
  let sessionCount = 0;
  let unauthorized = false;
  let brokenTier = false;
  let brokenAll = false;
  let corruptResponse = false;
  let plainResponse = false;
  let holdAniNami;
  let holdRest;
  let holdSub;
  let subLookupStarted;
  let streamingSegment = false;
  let finishSegment;
  const requestedTiers = new Set();
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers }
  });
  function encrypted(body) {
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(body)), cipher.final(), cipher.getAuthTag()]);
    if (corruptResponse) data[0] ^= 1;
    return { v: 1, i: iv.toString("base64"), d: data.toString("base64") };
  }
  const mockFetch = async (input, options = {}) => {
    const url = new URL(input);
    const headers = new Headers(options.headers);
    const playlist = (body) => {
      const response = new Response(body, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    };
    if (url.hostname === "anichan.to") {
      if (url.pathname.startsWith("/anime/")) {
        return new Response('<script src="/_next/static/chunks/player.js"></script>');
      }
      if (url.pathname.endsWith("player.js")) {
        // Like the upstream minified client, but with generated fixture keys.
        return new Response(`let P="1234abcd",k="${first.toString("base64")}",b="${second.toString("base64")}";const path="/api/watch/servers";`);
      }
      if (["/api/watch/session", "/api/watch/servers"].includes(url.pathname)) {
        assert.equal(headers.get("origin"), "https://anichan.to");
        assert.match(headers.get("referer"), /^https:\/\/anichan\.to\/anime\/\d+$/);
      } else {
        assert.equal(headers.get("referer"), "https://anichan.to/");
      }
      if (url.pathname === "/api/watch/session") {
        sessionCount++;
        assert.equal(options.method, "POST");
        return json({ ok: true, n: nonce }, 200, { "set-cookie": "anichan_ws=fixture; Path=/api/watch; Secure" });
      }
      if (url.pathname === "/api/watch/servers") {
        assert.equal(headers.get("cookie"), "anichan_ws=fixture");
        assert.equal(headers.get("x-wk"), "1234abcd");
        const tier = url.searchParams.get("tier");
        const audio = url.searchParams.get("category");
        assert.ok(["fast", "rest"].includes(tier));
        requestedTiers.add(`${audio}:${tier}`);
        if (audio === "sub" && holdSub) {
          subLookupStarted?.();
          await holdSub;
        }
        if (tier === "rest" && holdRest) await holdRest;
        if (unauthorized) {
          unauthorized = false;
          return json({ detail: "session" }, 401);
        }
        if (brokenAll || (brokenTier && tier === "rest")) return json({}, 503);
        const body = { servers: [{ name: "fixture", label: "HD", type: "hls",
          stream: `/api/watch/m3u8?audio=${audio}`,
          subtitles: [{ lang: "English", url: "/captions.vtt" }] }] };
        return json(plainResponse ? body : encrypted(body));
      }
      if (url.pathname === "/api/watch/m3u8") {
        return playlist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/media/episode.m3u8\n");
      }
      if (url.pathname === "/media/episode.m3u8") {
        return playlist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/media/key.bin"\n#EXTINF:4,\n/media/segment.ts\n');
      }
      if (url.pathname === "/media/segment.ts") {
        if (streamingSegment) return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from([0x47, 1]));
            finishSegment = () => {
              controller.enqueue(Buffer.from([2, 3]));
              controller.close();
            };
          }
        }), { headers: { "content-type": "image/jpeg" } });
        return new Response(Buffer.from([0x47, 1, 2, 3]));
      }
      if (url.pathname === "/captions.vtt") return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
    }
    if (url.hostname === "www.aninami.site") {
      if (holdAniNami) await holdAniNami;
      return json({}, 404);
    }
    if (url.hostname === "reanime.to") assert.fail("ReAnime must not be queried");
    throw new Error(`Unexpected upstream request: ${url}`);
  };
  globalThis.fetch = async (input, options) => {
    const response = await mockFetch(input, options);
    if (!response.url) Object.defineProperty(response, "url", { value: String(input) });
    return response;
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  await t.test("decrypts both tiers and audio tracks, deduplicates sources, resolves subtitles", async () => {
    const streams = await getAniChanStreams({ aniListId: 21, episode: 1 });
    assert.equal(streams.length, 2);
    assert.deepEqual([...requestedTiers].sort(), ["dub:fast", "dub:rest", "sub:fast", "sub:rest"]);
    assert.match(streams[0].title, /SUB/);
    assert.match(streams[1].title, /DUB/);
    assert.equal(streams[0].subtitles[0].url, "https://anichan.to/captions.vtt");
    assert.equal(streams[0].subtitles[0].lang, "eng");
  });
  await t.test("refreshes expired sessions and tolerates a failed tier", async () => {
    unauthorized = true;
    brokenTier = true;
    const before = sessionCount;
    assert.equal((await getAniChanStreams({ aniListId: 21, episode: 2 })).length, 2);
    assert.ok(sessionCount - before >= 5);
    brokenTier = false;
  });
  await t.test("retains support for unencrypted server lists", async () => {
    plainResponse = true;
    assert.equal((await getAniChanStreams({ aniListId: 21, episode: 3 })).length, 2);
    plainResponse = false;
  });
  await t.test("reports upstream errors instead of silently hiding them", async () => {
    brokenAll = true;
    await assert.rejects(getAniChanStreams({ aniListId: 21, episode: 4 }), /servers HTTP 503/);
    brokenAll = false;
    corruptResponse = true;
    await assert.rejects(getAniChanStreams({ aniListId: 21, episode: 4 }), /could not be decoded/);
    corruptResponse = false;
  });
  await t.test("serves streams and nested playback even when the other providers fail", async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await (await originalFetch(`${base}/stream/anime/anilist:21:5.json?debug=1`)).json();
    assert.equal(result.streams.length, 2);
    // Stremio's published contract requires this for non-MP4 URLs.
    assert.equal(result.streams[0].behaviorHints.notWebReady, true);
    assert.equal(result.streams[0].behaviorHints.filename, "master.m3u8");
    assert.equal(result.diagnostics.find((item) => item.provider === "getAniChanStreams").streams, 2);
    const playlist = await (await originalFetch(result.streams[0].url)).text();
    const childUrl = playlist.split("\n").find((line) => line.startsWith(base));
    assert.ok(childUrl);
    const child = await (await originalFetch(childUrl)).text();
    assert.match(child, /#EXT-X-KEY:METHOD=AES-128,URI="http:\/\/127\.0\.0\.1:/);
    const segmentUrl = child.split("\n").find((line) => line.startsWith(base));
    const segment = await originalFetch(segmentUrl);
    assert.equal(segment.status, 200);
    assert.equal(segment.headers.get("content-type"), "video/mp2t");
    assert.deepEqual(Buffer.from(await segment.arrayBuffer()), Buffer.from([0x47, 1, 2, 3]));
    const subtitles = await (await originalFetch(result.streams[0].subtitles[0].url)).text();
    assert.match(subtitles, /^WEBVTT/);

    streamingSegment = true;
    try {
      const streamed = await originalFetch(segmentUrl, { signal: AbortSignal.timeout(1500) });
      assert.equal(streamed.headers.get("content-type"), "video/mp2t");
      const reader = streamed.body.getReader();
      assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from([0x47, 1]));
      finishSegment();
      assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from([2, 3]));
    } finally {
      streamingSegment = false;
    }
  });
  await t.test("returns available streams while unrelated providers and tiers are still waiting", async () => {
    let releaseAniNami;
    let releaseRest;
    holdAniNami = new Promise((resolve) => { releaseAniNami = resolve; });
    holdRest = new Promise((resolve) => { releaseRest = resolve; });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const result = await (await originalFetch(`${base}/stream/anime/anilist:21:6.json?debug=1`, {
        signal: AbortSignal.timeout(1500)
      })).json();
      assert.equal(result.streams.length, 2);
      assert.ok(result.diagnostics.every((provider) => provider.pending));
      assert.equal(result.diagnostics.some((provider) => /ReAnime/.test(provider.provider)), false);
    } finally {
      releaseAniNami();
      releaseRest();
      holdAniNami = undefined;
      holdRest = undefined;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  await t.test("does not omit SUB when its lookup finishes after DUB", async () => {
    let releaseSub;
    let confirmSubStarted;
    const started = new Promise((resolve) => { confirmSubStarted = resolve; });
    holdSub = new Promise((resolve) => { releaseSub = resolve; });
    subLookupStarted = confirmSubStarted;
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      let completed = false;
      const response = originalFetch(`${base}/stream/anime/anilist:21:7.json?debug=1`, {
        signal: AbortSignal.timeout(2500)
      }).then((response) => { completed = true; return response.json(); });
      await started;
      // Deliberately outlast the former 350 ms window using an independently
      // controlled upstream response, then verify the client receives both.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(completed, false);
      releaseSub();
      const result = await response;
      assert.ok(result.streams.some((stream) => /\bSUB\b/.test(stream.title)));
      assert.ok(result.streams.some((stream) => /\bDUB\b/.test(stream.title)));
    } finally {
      releaseSub();
      holdSub = undefined;
      subLookupStarted = undefined;
    }
  });
});
