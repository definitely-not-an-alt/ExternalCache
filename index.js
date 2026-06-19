/**
 * ExternalCache Extension
 *
 * Rewrites external media URLs in chat messages to route through the
 * server plugin's cache endpoint, enabling offline access and privacy.
 *
 * Works by wrapping DOMPurify.sanitize() — when ST sanitizes message HTML
 * (with MESSAGE_SANITIZE config), we rewrite external URLs first. Covers
 * regular messages, creator notes, and anything else ST sanitizes.
 *
 * Only rewrites when external media is allowed for the current entity,
 * respecting ST's "Forbid External Media" setting and per-character overrides.
 */

import { renderSettings } from './settings.js';

/** @type {SillyTavernContext|null} */
let context = null;
/** @type {Object|null} */
let extensionSettings = null;
/** @type {typeof DOMPurify.sanitize|null} */
let originalSanitize = null;

// ============================================================================
// Activation
// ============================================================================

/**
 * Called when the extension is activated by SillyTavern.
 */
export async function onActivate() {
    console.log('[ExternalCache] Extension activating...');

    try {
        context = SillyTavern.getContext();
        extensionSettings = context.extensionSettings;

        if (!extensionSettings['externalcache']) {
            extensionSettings['externalcache'] = {
                enabled: false,
            };
        }

        try {
            const settingsHtml = await context.renderExtensionTemplateAsync(
                'third-party/externalcache',
                'settings',
            );
            $('#extensions_settings2').append(settingsHtml);
            renderSettings(context, extensionSettings['externalcache']);
        } catch (e) {
            console.error('[ExternalCache] Failed to render settings:', e);
        }

        wrapSanitize();
        expireOldCacheOnInit();

        window.__externalcache_exports = {
            unwrapSanitize,
        };

        console.log('[ExternalCache] Activated.');
    } catch (error) {
        console.error('[ExternalCache] Activation failed:', error);
    }
}

// ============================================================================
// Deactivation & Cleanup
// ============================================================================

/**
 * Called when the extension is disabled.
 */
export function onDisable() {
    unwrapSanitize();
    console.log('[ExternalCache] Disabled.');
}

/**
 * Called when the user clicks "Clean extension data".
 */
export async function onClean() {
    if (extensionSettings && extensionSettings['externalcache']) {
        delete extensionSettings['externalcache'];
        if (context) {
            context.saveSettingsDebounced();
        }
    }
    unwrapSanitize();
    console.log('[ExternalCache] Data cleaned.');
}

// ============================================================================
// DOMPurify.sanitize Wrapper
// ============================================================================

/**
 * Check if a URL is external (not served by this ST instance).
 * @param {string|null} url
 * @returns {boolean}
 */
function isExternalUrl(url) {
    if (!url) return false;
    return (url.indexOf('://') > 0 || url.indexOf('//') === 0) && !url.startsWith(window.location.origin);
}

/**
 * Rewrite a single URL if it's external.
 * @param {string} url
 * @returns {string}
 */
function rewriteUrl(url) {
    if (isExternalUrl(url)) {
        return `/api/plugins/external-cache/cache?url=${encodeURIComponent(url)}`;
    }
    return url;
}

/**
 * Rewrite all external media URLs in an HTML string.
 * @param {string} html
 * @returns {string}
 */
function rewriteExternalMedia(html) {
    // Rewrite <img> tags: src and srcset
    html = html.replace(/<img([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bsrc=["']([^"']*)["']/gi, (m, url) => {
            return `src="${rewriteUrl(url)}"`;
        });
        attrs = attrs.replace(/\bsrcset=["']([^"']*)["']/gi, (m, srcset) => {
            const rewritten = srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                if (parts[0] && isExternalUrl(parts[0])) {
                    parts[0] = rewriteUrl(parts[0]);
                }
                return parts.join(' ');
            }).join(', ');
            return `srcset="${rewritten}"`;
        });
        return `<img${attrs}>`;
    });

    // Rewrite <video> tags: src
    html = html.replace(/<video([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bsrc=["']([^"']*)["']/gi, (m, url) => {
            return `src="${rewriteUrl(url)}"`;
        });
        return `<video${attrs}>`;
    });

    // Rewrite <audio> tags: src
    html = html.replace(/<audio([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bsrc=["']([^"']*)["']/gi, (m, url) => {
            return `src="${rewriteUrl(url)}"`;
        });
        return `<audio${attrs}>`;
    });

    // Rewrite <source> tags: src
    html = html.replace(/<source([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bsrc=["']([^"']*)["']/gi, (m, url) => {
            return `src="${rewriteUrl(url)}"`;
        });
        return `<source${attrs}>`;
    });

    // Rewrite <embed> tags: src
    html = html.replace(/<embed([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bsrc=["']([^"']*)["']/gi, (m, url) => {
            return `src="${rewriteUrl(url)}"`;
        });
        return `<embed${attrs}>`;
    });

    // Rewrite <object> tags: data
    html = html.replace(/<object([^>]*)>/gi, (match, attrs) => {
        attrs = attrs.replace(/\bdata=["']([^"']*)["']/gi, (m, url) => {
            return `data="${rewriteUrl(url)}"`;
        });
        return `<object${attrs}>`;
    });

    // Rewrite CSS background-image URLs
    html = html.replace(/background-image:\s*url\(["']?([^"')\s]+)["']?\)/gi, (m, url) => {
        return `background-image: url(${rewriteUrl(url)})`;
    });

    return html;
}

/**
 * Expire old cache files on extension activate.
 */
async function expireOldCacheOnInit() {
    const ttlDays = extensionSettings?.['externalcache']?.cache_ttl_days ?? 30;
    try {
        const response = await fetch(`/api/plugins/external-cache/expire?days=${ttlDays}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${SillyTavern.getContext().user.token}`,
            },
        });
        if (response.ok) {
            const data = await response.json();
            if (data.expired > 0) {
                console.log(`[ExternalCache] Expired ${data.expired} old file(s) on init.`);
            }
        }
    } catch (error) {
        console.warn('[ExternalCache] Could not expire old cache on init:', error.message);
    }
}

/**
 * Wrap DOMPurify.sanitize to rewrite external URLs after sanitization.
 * Runs originalSanitize first — if external media is forbidden, the built-in
 * hook removes it and shows the toast. If allowed, elements survive and we
 * rewrite their URLs afterwards.
 */
function wrapSanitize() {
    const { DOMPurify } = SillyTavern.libs;
    if (!DOMPurify) return;

    originalSanitize = DOMPurify.sanitize.bind(DOMPurify);

    DOMPurify.sanitize = function (html, config) {
        const settings = extensionSettings?.['externalcache'];
        const isMessageSanitize = config && config.MESSAGE_SANITIZE;

        if (settings && settings.enabled && isMessageSanitize && typeof html === 'string') {
            html = originalSanitize(html, config);
            html = rewriteExternalMedia(html);
        } else {
            html = originalSanitize(html, config);
        }

        return html;
    };

    console.log('[ExternalCache] DOMPurify.sanitize wrapped.');
}

/**
 * Restore original DOMPurify.sanitize.
 */
function unwrapSanitize() {
    if (!originalSanitize) return;

    const { DOMPurify } = SillyTavern.libs;
    if (DOMPurify) {
        DOMPurify.sanitize = originalSanitize;
    }
    originalSanitize = null;

    console.log('[ExternalCache] DOMPurify.sanitize restored.');
}
