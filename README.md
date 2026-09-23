# Raghav Anime — Stremio and Nuvio addon

This is a standard Stremio-compatible HTTP addon. It does not require CloudStream, a `.cs3` loader, or CNCVerse Bridge on the user's device.

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

The same manifest works in Stremio and Nuvio.

## Implemented aggregate sources

- AniNami's provider aggregation (SUB and DUB, direct HLS/MP4, subtitles)
- AniChan (SUB and DUB, including its Vidhawk resolver)

Providers are fault-isolated; one upstream failure does not fail the stream response.
