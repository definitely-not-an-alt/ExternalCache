# ExternalCache

Caches external media from SillyTavern chat messages through the server for offline access.

## Install

### 1. Install Client Extension

Install from SillyTavern UI: **Download Extensions & Assets** → paste `https://github.com/definitely-not-an-alt/ExternalCache`

This clones the repo into `data/<your-handle>/extensions/externalcache/`.

### 2. Link Server Plugin

```bash
ln -s data/<your-handle>/extensions/externalcache/server SillyTavern/plugins/external-cache
```

This symlinks the `server/` directory so ST's plugin loader can find it. Updates to the extension also update the server plugin automatically.

### 3. Enable

Set `enableServerPlugins: true` in `config.yaml`, then restart SillyTavern.

### 4. Activate

Open SillyTavern → **Manage Extensions** → enable ExternalCache.

## Cache Location

Cached files are stored in `data/<your-handle>/external_media_cache/` with SHA-256 hash filenames and JSON metadata files.
