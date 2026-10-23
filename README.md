# Raghav Anime — Stremio and Nuvio addon

This is a standard Stremio-compatible HTTP addon. It does not require CloudStream, a `.cs3` loader, or CNCVerse Bridge on the user's device. Playback links are served through the addon so required provider headers reach HLS playlists and video segments.

## Run locally

```bash
npm start
```

The manifest is served at `http://127.0.0.1:7000/manifest.json`.

## Deploy

The repository includes a `Dockerfile` and `render.yaml`. Deploy it to any Docker-capable host, then install:

```text
https://YOUR-HOST/manifest.json
```

The same manifest works in Stremio and Nuvio. It accepts IMDb, Kitsu, AniList, MAL, and TMDB episode IDs and handles the `anime` content type used by anime catalogs. Source subtitles are exposed both on individual streams and through Stremio's subtitle resource. A source that supplies no subtitles cannot provide a matching subtitle track; tracks from other sources are labeled separately.

## Implemented aggregate sources

- AniNami's provider aggregation (SUB and DUB, direct HLS/MP4, subtitles)
- AniChan (SUB and DUB, including its Vidhawk resolver)
- ReAnime (FlixCloud HLS with encrypted playlist and segment handling; source ASS subtitles converted to VTT)

Providers are fault-isolated; one upstream failure does not fail the stream response.

## Stream loading fix (1.3.3)

AniChan now requires a watch-page Referer, separate `fast` and `rest` tier requests,
and session-bound encrypted server responses. The addon reads the current public
player configuration, decodes those responses, and merges SUB/DUB sources. It
refreshes expired sessions and reports provider failures through diagnostics.

AniNami's configured API currently returns 404. ReAnime can return a Cloudflare
403 challenge to Render's datacenter IPs even when it works on a home connection;
the native HTTPS fallback does not solve that block. AniChan supplies independent
streams when those providers are unavailable.

After deploying this version, check:

```text
https://YOUR-HOST/stream/anime/anilist:21:1.json?debug=1
```

The response includes provider stream counts and errors. Verify the manifest says
`1.3.3`, then reopen the episode in Stremio or Nuvio. If the client retains the old
manifest, remove and reinstall the addon using the same manifest URL.

Run `npm test` for offline regression tests covering encrypted responses, session
refresh, partial provider failure, subtitles, and nested HLS proxy playback.
