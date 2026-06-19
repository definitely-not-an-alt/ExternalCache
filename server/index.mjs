/**
 * ExternalCache Server Plugin
 *
 * Fetches and caches external media URLs from chat messages.
 * Serves cached files on subsequent requests to enable offline access.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ============================================================================
// Plugin Info
// ============================================================================

export const info = {
    id: 'externalcache',
    name: 'ExternalCache',
    description: 'Caches external media from chat messages for offline access and privacy.',
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the cache directory for a user.
 * @param {object} req - Express request object
 * @returns {string|null} Path to user's cache directory, or null if unavailable
 */
function getCacheDir(req) {
    if (!req.user || !req.user.directories || !req.user.directories.root) {
        return null;
    }
    const cacheDir = path.join(req.user.directories.root, 'external_media_cache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
}

/**
 * Generate a safe filename from a URL using SHA-256 hash.
 * @param {string} url - The external URL
 * @returns {string} Hash string to use as filename
 */
function urlToHash(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

/**
 * Get the file extension for a URL or Content-Type.
 * @param {string} url - The source URL
 * @param {string} contentType - The Content-Type header from the response
 * @returns {string} File extension with dot, e.g. '.png'
 */
function getExtension(url, contentType) {
    if (contentType) {
        const typeMap = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
            'image/bmp': '.bmp',
            'image/tiff': '.tiff',
            'video/mp4': '.mp4',
            'video/webm': '.webm',
            'video/ogg': '.ogg',
            'audio/mpeg': '.mp3',
            'audio/ogg': '.ogg',
            'audio/wav': '.wav',
            'audio/webm': '.webm',
        };
        const type = contentType.split(';')[0].trim().toLowerCase();
        if (typeMap[type]) {
            return typeMap[type];
        }
    }
    const ext = path.extname(new URL(url).pathname);
    return ext || '.bin';
}

/**
 * Read metadata JSON for a cached file.
 * @param {string} cacheDir - Path to cache directory
 * @param {string} hash - Hash of the URL
 * @returns {object|null} Metadata object or null
 */
function readMetadata(cacheDir, hash) {
    const metaPath = path.join(cacheDir, `${hash}.meta.json`);
    if (fs.existsSync(metaPath)) {
        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Write metadata JSON for a cached file.
 * @param {string} cacheDir - Path to cache directory
 * @param {string} hash - Hash of the URL
 * @param {object} meta - Metadata object
 */
function writeMetadata(cacheDir, hash, meta) {
    const metaPath = path.join(cacheDir, `${hash}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Log a message with the plugin prefix.
 * @param {string} message
 */
function log(message) {
    console.log(`[ExternalCache] ${message}`);
}

/**
 * Read server-side config for a user.
 * @param {string} cacheDir - Path to cache directory
 * @returns {object} Config object
 */
function readConfig(cacheDir) {
    const configPath = path.join(cacheDir, '.config.json');
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
            return {};
        }
    }
    return {};
}

/**
 * Write server-side config for a user.
 * @param {string} cacheDir - Path to cache directory
 * @param {object} config - Config object
 */
function writeConfig(cacheDir, config) {
    const configPath = path.join(cacheDir, '.config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Evict oldest cached files until total size is under the limit.
 * @param {string} cacheDir - Path to cache directory
 * @param {number} maxSizeMB - Maximum cache size in MB (0 = disabled)
 */
function enforceSizeCap(cacheDir, maxSizeMB) {
    if (maxSizeMB <= 0) return;

    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const files = fs.readdirSync(cacheDir).filter(f => !f.endsWith('.meta.json') && !f.startsWith('.'));

    const entries = files.map(file => {
        const filePath = path.join(cacheDir, file);
        const stats = fs.statSync(filePath);
        const nameWithoutExt = path.basename(file, path.extname(file));
        const meta = readMetadata(cacheDir, nameWithoutExt);
        const lastUsed = meta ? (meta.lastUsed || meta.cachedAt) : stats.ctime.toISOString();
        return { file, size: stats.size, lastUsed };
    });

    entries.sort((a, b) => new Date(a.lastUsed) - new Date(b.lastUsed));

    let totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    if (totalSize <= maxSizeBytes) return;

    let evicted = 0;
    for (const entry of entries) {
        if (totalSize <= maxSizeBytes) break;
        if (evicted >= entries.length - 1) break;

        fs.unlinkSync(path.join(cacheDir, entry.file));
        const nameWithoutExt = path.basename(entry.file, path.extname(entry.file));
        const metaPath = path.join(cacheDir, `${nameWithoutExt}.meta.json`);
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
        }
        totalSize -= entry.size;
        evicted++;
    }

    log(`Size cap: evicted ${evicted} file(s) to stay under ${maxSizeMB} MB`);
}

/**
 * Resolve proxy URL from config, falling back to env vars.
 * @param {object} config - User config object
 * @returns {string|null} Proxy URL or null
 */
function resolveProxy(config) {
    if (config.proxy_url && typeof config.proxy_url === 'string' && config.proxy_url.trim()) {
        return config.proxy_url.trim();
    }
    if (process.env.HTTPS_PROXY && process.env.HTTPS_PROXY.trim()) {
        return process.env.HTTPS_PROXY.trim();
    }
    if (process.env.HTTP_PROXY && process.env.HTTP_PROXY.trim()) {
        return process.env.HTTP_PROXY.trim();
    }
    return null;
}

/**
 * Fetch a URL using http/https modules with optional proxy.
 * @param {string} url - URL to fetch
 * @param {ProxyAgent} agent - Proxy agent (optional)
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: Map<string,string>, arrayBuffer: () => Promise<ArrayBuffer>}>}
 */
function fetchWithProxy(url, agent) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { agent, timeout: 30000 }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusText: res.statusMessage || '',
                    headers: new Map(Object.entries(res.headers || {})),
                    arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * GET /cache?url={external_url}
 * Fetches external media, caches it, and serves it.
 */
async function handleCache(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const url = req.query.url;
    if (!url) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        const decodedUrl = decodeURIComponent(url);
        const hash = urlToHash(decodedUrl);

        // Check meta file for cached entry
        const meta = readMetadata(cacheDir, hash);
        if (meta && !req.query.t) {
            const cachedFile = `${hash}${meta.ext}`;
            const filePath = path.resolve(cacheDir, cachedFile);
            if (fs.existsSync(filePath)) {
                meta.lastUsed = new Date().toISOString();
                writeMetadata(cacheDir, hash, meta);

                res.set('Cache-Control', 'public, max-age=31536000, immutable');
                if (meta.contentType) {
                    res.set('Content-Type', meta.contentType);
                }
                return res.sendFile(filePath);
            }
        }

        // Fetch from external URL
        const config = readConfig(cacheDir);
        const proxyUrl = resolveProxy(config);
        let response;
        if (proxyUrl) {
            let agent;
            if (proxyUrl.match(/^socks[45]?h?:\/\//)) {
                agent = new SocksProxyAgent(proxyUrl);
            } else if (decodedUrl.startsWith('https')) {
                agent = new HttpsProxyAgent(proxyUrl);
            } else {
                agent = new HttpProxyAgent(proxyUrl);
            }
            response = await fetchWithProxy(decodedUrl, agent);
        } else {
            response = await fetch(decodedUrl, { redirect: 'follow' });
        }

        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const extension = getExtension(decodedUrl, contentType);
        const filename = `${hash}${extension}`;
        const filePath = path.join(cacheDir, filename);

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);

        writeMetadata(cacheDir, hash, {
            url: decodedUrl,
            contentType: contentType,
            ext: extension,
            size: buffer.length,
            cachedAt: new Date().toISOString(),
        });

        log(`Cached: ${decodedUrl} (${(buffer.length / 1024).toFixed(1)} KB)`);

        enforceSizeCap(cacheDir, config.cache_max_size_mb || 0);

        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Content-Type', contentType);
        res.set('Content-Length', buffer.length);
        return res.send(buffer);

    } catch (error) {
        log(`Error caching ${url}: ${error.message}`);
        return res.status(502).send(`Proxy error: ${error.message}`);
    }
}

/**
 * GET /list
 * Returns list of all cached files with metadata.
 */
function handleList(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const entries = [];
    const files = fs.readdirSync(cacheDir).filter(f => !f.endsWith('.meta.json') && !f.startsWith('.'));

    for (const file of files) {
        const nameWithoutExt = path.basename(file, path.extname(file));
        const meta = readMetadata(cacheDir, nameWithoutExt);
        const stats = fs.statSync(path.join(cacheDir, file));

        entries.push({
            filename: file,
            hash: nameWithoutExt,
            url: meta ? meta.url : 'unknown',
            contentType: meta ? meta.contentType : 'unknown',
            size: stats.size,
            cachedAt: meta ? meta.cachedAt : new Date(stats.ctime).toISOString(),
            lastUsed: meta ? (meta.lastUsed || meta.cachedAt) : new Date(stats.ctime).toISOString(),
        });
    }

    entries.sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt));
    return res.json(entries);
}

/**
 * DELETE /:filename
 * Removes a single cached file and its metadata.
 */
function handleDelete(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const filename = req.params.filename;
    const filePath = path.join(cacheDir, filename);

    // Prevent path traversal
    if (!path.resolve(filePath).startsWith(path.resolve(cacheDir))) {
        return res.status(400).send('Invalid filename');
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }

    fs.unlinkSync(filePath);

    const nameWithoutExt = path.basename(filename, path.extname(filename));
    const metaPath = path.join(cacheDir, `${nameWithoutExt}.meta.json`);
    if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
    }

    log(`Deleted: ${filename}`);
    return res.json({ success: true });
}

/**
 * DELETE /expire?days=N
 * Removes cached files older than N days (based on lastUsed).
 */
function handleExpire(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const days = parseInt(req.query.days, 10);
    if (isNaN(days) || days < 1) {
        return res.status(400).send('Invalid days parameter (must be >= 1)');
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    let count = 0;

    const files = fs.readdirSync(cacheDir).filter(f => !f.endsWith('.meta.json') && !f.startsWith('.'));
    for (const file of files) {
        const nameWithoutExt = path.basename(file, path.extname(file));
        const meta = readMetadata(cacheDir, nameWithoutExt);
        const lastUsed = meta ? (meta.lastUsed || meta.cachedAt) : '';
        if (lastUsed && new Date(lastUsed) < cutoff) {
            fs.unlinkSync(path.join(cacheDir, file));
            const metaPath = path.join(cacheDir, `${nameWithoutExt}.meta.json`);
            if (fs.existsSync(metaPath)) {
                fs.unlinkSync(metaPath);
            }
            count++;
        }
    }

    log(`Expired cache: ${count} files older than ${days} days removed`);
    return res.json({ success: true, expired: count });
}

/**
 * PUT /config
 * Updates server-side config (size cap, etc.).
 */
function handleConfig(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const config = readConfig(cacheDir);
    if (req.body.cache_max_size_mb !== undefined) {
        config.cache_max_size_mb = parseFloat(req.body.cache_max_size_mb) || 0;
    }
    if (req.body.proxy_url !== undefined) {
        config.proxy_url = typeof req.body.proxy_url === 'string' ? req.body.proxy_url.trim() : '';
    }
    writeConfig(cacheDir, config);

    enforceSizeCap(cacheDir, config.cache_max_size_mb || 0);
    return res.json({ success: true });
}

/**
 * DELETE /
 * Clears all cached files.
 */
function handleClear(req, res) {
    const cacheDir = getCacheDir(req);
    if (!cacheDir) {
        return res.status(401).send('Unauthorized');
    }

    const files = fs.readdirSync(cacheDir);
    let count = 0;

    for (const file of files) {
        const filePath = path.join(cacheDir, file);
        if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
            count++;
        }
    }

    log(`Cleared cache: ${count} files removed`);
    return res.json({ success: true, deleted: count });
}

// ============================================================================
// Plugin Initialization
// ============================================================================

/**
 * Initialize the plugin and register routes.
 * @param {import('express').Router} router - Express router
 */
export async function init(router) {
    log('ExternalCache server plugin initializing...');

    router.get('/cache', handleCache);
    router.get('/list', handleList);
    router.put('/config', handleConfig);
    router.delete('/expire', handleExpire);
    router.delete('/:filename', handleDelete);
    router.delete('/', handleClear);

    log('ExternalCache server plugin initialized');
}

/**
 * Cleanup function called on server shutdown.
 */
export async function exit() {
    log('ExternalCache server plugin shutting down...');
}
