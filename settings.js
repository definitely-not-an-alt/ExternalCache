/**
 * ExternalCache Settings Module
 *
 * Handles rendering and managing the settings UI.
 */

/** @type {SillyTavernContext|null} */
let context = null;
/** @type {Object|null} */
let settings = null;
/** @type {Array<Object>} */
let cacheEntries = [];
/** @type {{field: string, asc: boolean}} */
let sortState = { field: 'cached', asc: false };

/**
 * Initialize the settings module.
 * @param {Object} ctx - SillyTavern context
 * @param {Object} extSettings - Extension settings object
 */
export function renderSettings(ctx, extSettings) {
    context = ctx;
    settings = extSettings;

    $('#externalcache_enabled').on('change', onEnabledChange);
    $('#externalcache_refresh_cache').on('click', onRefreshCache);
    $('#externalcache_clear_all').on('click', clearAllCache);
    $('#externalcache_expire').on('click', expireOldCache);
    $('#externalcache_ttl_days').on('change', onTtlChange);
    $('#externalcache_max_size_mb').on('change', onMaxSizeChange);
    $('#externalcache_proxy_url').on('change', onProxyChange);
    $('.externalcache_sortable').on('click', onSortClick);

    populateSettings();
    loadCacheList();
}

/**
 * Populate UI elements with current settings values.
 */
function populateSettings() {
    if (!settings) return;
    $('#externalcache_enabled').prop('checked', !!settings.enabled);
    $('#externalcache_ttl_days').val(settings.cache_ttl_days || 30);
    $('#externalcache_max_size_mb').val(settings.cache_max_size_mb || 0);
    $('#externalcache_proxy_url').val(settings.proxy_url || '');
}

/**
 * Handle the enabled toggle change.
 */
function onEnabledChange() {
    if (!settings || !context) return;

    settings.enabled = !!$('#externalcache_enabled').prop('checked');
    context.saveSettingsDebounced();

    if (settings.enabled) {
        toastr.info('ExternalCache enabled — reloading chat to apply', 'ExternalCache');
    } else {
        toastr.info('ExternalCache disabled — reloading chat to apply', 'ExternalCache');
    }

    // Reload current chat so existing messages are re-rendered with the new setting
    setTimeout(() => {
        const { reloadCurrentChat } = context;
        if (typeof reloadCurrentChat === 'function') {
            reloadCurrentChat();
        }
    }, 200);
}

/**
 * Load the cache list from the server plugin.
 */
async function loadCacheList() {
    const listEl = $('#externalcache_cache_list');
    const countEl = $('#externalcache_cache_count');
    listEl.html('<tr><td colspan="5" style="text-align:center;color:#888;">Loading...</td></tr>');

    try {
        const response = await fetch('/api/plugins/externalcache/list', {
            headers: context.getRequestHeaders(),
        });

        if (!response.ok) {
            listEl.html('<tr><td colspan="5" style="text-align:center;color:#f44336;">Server plugin not connected</td></tr>');
            countEl.text('0');
            return;
        }

        cacheEntries = await response.json();
        renderCacheList();

    } catch (error) {
        listEl.html('<tr><td colspan="5" style="text-align:center;color:#f44336;">Failed to load cache list</td></tr>');
        countEl.text('0');
    }
}

function renderCacheList() {
    const listEl = $('#externalcache_cache_list');
    const countEl = $('#externalcache_cache_count');
    const { field, asc } = sortState;

    const sorted = [...cacheEntries].sort((a, b) => {
        let va, vb;
        if (field === 'size') {
            va = a.size;
            vb = b.size;
            return asc ? va - vb : vb - va;
        }
        va = new Date(field === 'cached' ? a.cachedAt : a.lastUsed).getTime();
        vb = new Date(field === 'cached' ? b.cachedAt : b.lastUsed).getTime();
        return asc ? va - vb : vb - va;
    });

    countEl.text(sorted.length);

    if (sorted.length === 0) {
        listEl.html('<tr><td colspan="5" style="text-align:center;color:#888;">No cached files</td></tr>');
        return;
    }

    listEl.html('');
    for (const entry of sorted) {
        const size = formatSize(entry.size);
        const cached = formatRelativeTime(entry.cachedAt);
        const lastUsed = formatRelativeTime(entry.lastUsed);
        const urlDisplay = entry.url.length > 60 ? entry.url.substring(0, 60) + '...' : entry.url;

        const row = $(`
            <tr>
                <td class="externalcache_url" title="${escapeHtml(entry.url)}">${escapeHtml(urlDisplay)}</td>
                <td>${size}</td>
                <td>${cached}</td>
                <td>${lastUsed}</td>
                <td>
                    <button class="menu_button externalcache_delete_btn" data-filename="${escapeHtml(entry.filename)}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>
        `);

        row.find('.externalcache_delete_btn').on('click', () => deleteEntry(entry.filename));
        listEl.append(row);
    }

    updateSortIcons();
}

/**
 * Delete a single cache entry.
 * @param {string} filename - Filename to delete
 */
async function deleteEntry(filename) {
    try {
        const response = await fetch(`/api/plugins/externalcache/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            headers: context.getRequestHeaders(),
        });

        if (response.ok) {
            toastr.success('Entry removed', 'ExternalCache');
            loadCacheList();
        } else {
            toastr.error('Failed to remove entry', 'ExternalCache');
        }
    } catch (error) {
        toastr.error(`Error: ${error.message}`, 'ExternalCache');
    }
}

/**
 * Refresh the cache list (reload current chat to re-cache media).
 */
async function onRefreshCache() {
    loadCacheList();
}

function onTtlChange() {
    if (!settings) return;
    settings.cache_ttl_days = parseInt($('#externalcache_ttl_days').val(), 10) || 30;
    context.saveSettingsDebounced();
    syncServerConfig();
}

function onMaxSizeChange() {
    if (!settings) return;
    settings.cache_max_size_mb = parseFloat($('#externalcache_max_size_mb').val(), 10) || 0;
    context.saveSettingsDebounced();
    syncServerConfig();
}

function onProxyChange() {
    if (!settings) return;
    settings.proxy_url = $('#externalcache_proxy_url').val().trim() || '';
    context.saveSettingsDebounced();
    syncServerConfig();
}

async function syncServerConfig() {
    if (!settings || !context) return;
    try {
        const res = await fetch('/api/plugins/externalcache/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...context.getRequestHeaders(),
            },
            body: JSON.stringify({
                cache_max_size_mb: settings.cache_max_size_mb || 0,
                proxy_url: settings.proxy_url || '',
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.warn(`[ExternalCache] Failed to sync config: ${res.status} ${err}`);
        }
    } catch (e) {
        console.warn(`[ExternalCache] Config sync error:`, e);
    }
}

async function expireOldCache() {
    const days = parseInt($('#externalcache_ttl_days').val(), 10) || 30;
    if (!confirm(`Remove cached files not accessed in the last ${days} days?`)) return;

    try {
        const response = await fetch(`/api/plugins/externalcache/expire?days=${days}`, {
            method: 'DELETE',
            headers: context.getRequestHeaders(),
        });

        if (response.ok) {
            const data = await response.json();
            toastr.success(`Expired ${data.expired} file(s)`, 'ExternalCache');
            loadCacheList();
        } else {
            toastr.error('Failed to expire cache', 'ExternalCache');
        }
    } catch (error) {
        toastr.error(`Error: ${error.message}`, 'ExternalCache');
    }
}

function onSortClick(e) {
    const field = $(e.currentTarget).data('sort');
    if (sortState.field === field) {
        sortState.asc = !sortState.asc;
    } else {
        sortState.field = field;
        sortState.asc = false;
    }
    renderCacheList();
}

function updateSortIcons() {
    $('.externalcache_sortable i').removeClass('fa-sort fa-sort-up fa-sort-down');
    const $active = $(`.externalcache_sortable[data-sort="${sortState.field}"] i`);
    $active.addClass(sortState.asc ? 'fa-sort-up' : 'fa-sort-down');
}

/**
 * Clear all cached files.
 */
async function clearAllCache() {
    if (!confirm('Clear all cached media files?')) return;

    try {
        const response = await fetch('/api/plugins/externalcache/', {
            method: 'DELETE',
            headers: context.getRequestHeaders(),
        });

        if (response.ok) {
            const data = await response.json();
            toastr.success(`Cleared ${data.deleted} file(s)`, 'ExternalCache');
            loadCacheList();
        } else {
            toastr.error('Failed to clear cache', 'ExternalCache');
        }
    } catch (error) {
        toastr.error(`Error: ${error.message}`, 'ExternalCache');
    }
}

/**
 * Format file size in human-readable form.
 * @param {number} bytes
 * @returns {string}
 */
const relativeTimeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function formatRelativeTime(isoString) {
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    const minutes = Math.floor(diff / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);

    if (minutes < 1) return relativeTimeFmt.format(-diff, 'second');
    if (hours < 1) return relativeTimeFmt.format(-minutes, 'minute');
    if (days < 1) return relativeTimeFmt.format(-hours, 'hour');
    if (weeks < 1) return relativeTimeFmt.format(-days, 'day');
    if (months < 1) return relativeTimeFmt.format(-weeks, 'week');
    return relativeTimeFmt.format(-months, 'month');
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Get exports from the main module for cross-module communication.
 * @returns {Object} Module exports
 */
function getModuleExports() {
    return window.__externalcache_exports || {};
}
