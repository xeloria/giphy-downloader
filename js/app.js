/*
 * Giphy Downloader
 * Author: Xeloria (https://github.com/xeloria)
 */

$(function () {
    const DEFAULT_API_KEY = "GlVGYHkr3WSBnllca54iNt0yFbjz7L65";
    const FALLBACK_API_KEY = "dc6zaTOxFJmzC";
    const LS_API_KEY = "giphy_api_key";
    const PAGE_LIMIT_SINGLE = 24;
    const PAGE_LIMIT_ALL_EACH = 24; // 24 gifs + 24 stickers = 48 per page for "All"
    const MAX_ZIP_ITEMS = 500;
    const ZIP_CONCURRENCY = 4;

    let currentUsername = null;
    let currentSearchQuery = null;
    let currentFilter = 'all'; // 'all' | 'gifs' | 'stickers'
    let gifsOffset = 0;
    let stickersOffset = 0;
    let gifsTotal = 0;
    let stickersTotal = 0;
    let loadedGifs = [];
    let loadedStickers = [];
    let selectedIds = new Set();
    let isLoading = false;
    let debounceTimer = null;
    let requestController = null;
    let requestVersion = 0;

    // --- API Key handling ---
    function getApiKey() {
        return localStorage.getItem(LS_API_KEY) || DEFAULT_API_KEY;
    }
    function setApiKey(key) {
        if (key && key.trim()) {
            localStorage.setItem(LS_API_KEY, key.trim());
        }
    }
    function initApiKeyUI() {
        const stored = localStorage.getItem(LS_API_KEY);
        $('#apiKeyInput').val(stored || '');
        updateApiKeyStatus();
    }
    function updateApiKeyStatus() {
        const key = getApiKey();
        const isDefault = !localStorage.getItem(LS_API_KEY);
        if (isDefault) {
            $('#apiKeyStatus').text('Using public demo key (rate-limited). Add your own for best results (developers.giphy.com).').removeClass('error').addClass('success');
        } else {
            $('#apiKeyStatus').text('Using custom API key: ' + key.substring(0, 6) + '...' ).removeClass('error').addClass('success');
        }
    }

    $('#saveApiKey').on('click', function () {
        const val = $('#apiKeyInput').val().trim();
        if (!val) {
            $('#apiKeyStatus').text('Please enter a valid API key.').removeClass('success').addClass('error');
            return;
        }
        setApiKey(val);
        updateApiKeyStatus();
        $('#apiKeyStatus').text('API key saved! Try your user URL again.').removeClass('error').addClass('success');
        if (currentUsername) {
            fetchUserGifs(currentUsername, false);
        } else if (currentSearchQuery) {
            fetchSearchGifs(currentSearchQuery, 0, false);
        }
    });
    $('#resetApiKey').on('click', function () {
        localStorage.removeItem(LS_API_KEY);
        $('#apiKeyInput').val('');
        updateApiKeyStatus();
        $('#apiKeyStatus').text('Reset to default demo key.').removeClass('error').addClass('success');
    });

    // --- Helpers ---
    function showStatus(msg, isError) {
        if (!msg) {
            $('#status-message').text('').hide();
            $('#user-status').text('');
            return;
        }
        $('#status-message').text(msg).css('color', isError ? '#ff6b6b' : '#aaa').show();
        $('#user-status').text(msg).css('color', isError ? '#ff6b6b' : '#aaa');
    }

    function showCopyAlert() {
        $('#copy-alert').addClass('show');
        setTimeout(function () { $('#copy-alert').removeClass('show'); }, 3000);
    }
    let infoAlertTimer = null;
    function showInfoAlert(text) {
        $('#status-alert-text').text(text);
        $('#status-alert').show().addClass('show');
        // Reset the previous timer so a new alert is not hidden by the old one.
        clearTimeout(infoAlertTimer);
        infoAlertTimer = setTimeout(function () { $('#status-alert').removeClass('show').hide(); }, 4000);
    }

    function cancelPendingRequest() {
        requestVersion++;
        if (requestController) {
            requestController.abort();
            requestController = null;
        }
        isLoading = false;
    }

    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            showCopyAlert();
        } catch (e) {
            // Fall back to a detached textarea so the visible input is never touched.
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showCopyAlert();
            } catch (e2) { /* clipboard unavailable in this context */ }
        }
    }

    function resetViews() {
        cancelPendingRequest();
        $('#single-gif-section').hide();
        $('#user-gifs-section').hide();
        $('#gifs-grid').empty();
        $('#user-title').text('');
        $('#user-subtitle').text('');
        $('#selection-count').text('0 selected / 0 visible');
        $('#total-count').text('');
        $('#load-more').hide();
        $('#load-more-hint').text('');
        $('#zip-progress').hide();
        $('#download-selected').prop('disabled', true).text('Download Selected as ZIP (0)');
        $('#download-all').prop('disabled', true);
        loadedGifs = [];
        loadedStickers = [];
        selectedIds.clear();
        currentUsername = null;
        currentSearchQuery = null;
        gifsOffset = 0;
        stickersOffset = 0;
        gifsTotal = 0;
        stickersTotal = 0;
        updateFilterBadges();
        showStatus('', false);
    }

    function showSingleGif(gifId, directLink) {
        resetViews();
        $('#direct-gif-link').val(directLink);
        $('#download-single').attr('href', directLink).attr('download', gifId + '.gif');
        $('#single-gif-section').show();
        $('#user-gifs-section').hide();
        showStatus('GIF ready to copy or download.', false);
    }

    function showDefaultPreview() {
        resetViews();
        $('#direct-gif-link').val('');
        $('#download-single').attr('href', '#');
        $('#single-gif-section').hide();
    }

    function updateFilterBadges() {
        $('#count-gifs').text(gifsTotal || 0);
        $('#count-stickers').text(stickersTotal || 0);
        $('#count-all').text((gifsTotal || 0) + (stickersTotal || 0));
    }

    function getFilteredGifs() {
        if (currentFilter === 'gifs') return loadedGifs;
        if (currentFilter === 'stickers') return loadedStickers;
        // 'all' - merge and sort by import_datetime desc (missing/invalid dates sort last)
        const combined = [...loadedGifs, ...loadedStickers];
        combined.sort((a, b) => ((Date.parse(b.import_datetime) || 0) - (Date.parse(a.import_datetime) || 0)));
        return combined;
    }

    function updateSubtitle() {
        const allTotal = (gifsTotal || 0) + (stickersTotal || 0);
        const filtered = getFilteredGifs();
        if (currentSearchQuery) {
            $('#user-subtitle').text(`Showing ${loadedGifs.length} of ${gifsTotal} GIF results for “${currentSearchQuery}”`);
            $('#total-count').text(`(${loadedGifs.length} loaded)`);
        } else if (currentFilter === 'all') {
            $('#user-subtitle').text(`Showing ${filtered.length} of ${allTotal} items (${gifsTotal} GIFs + ${stickersTotal} Stickers) for @${currentUsername}`);
            $('#total-count').text(`(${filtered.length} / ${allTotal} loaded)`);
        } else if (currentFilter === 'gifs') {
            $('#user-subtitle').text(`Showing ${loadedGifs.length} of ${gifsTotal} GIFs for @${currentUsername}`);
            $('#total-count').text(`(${loadedGifs.length} loaded)`);
        } else if (currentFilter === 'stickers') {
            $('#user-subtitle').text(`Showing ${loadedStickers.length} of ${stickersTotal} Stickers for @${currentUsername}`);
            $('#total-count').text(`(${loadedStickers.length} loaded)`);
        }
        updateFilterBadges();
        // infinite-scroll hint
        const remaining = currentFilter === 'all' ? (allTotal - filtered.length) : (currentFilter === 'gifs' ? gifsTotal - loadedGifs.length : stickersTotal - loadedStickers.length);
        if (remaining > 0) {
            $('#load-more-hint').text(`${remaining} more available — scroll to load`);
        } else {
            $('#load-more-hint').text('All items loaded');
        }
    }

    // --- URL Parsing ---
    const RESERVED = new Set(['gifs','stickers','clips','embed','search','trending','explore','categories','channel','channels','stories','showdown']);

    function parseGiphyUrl(input) {
        const raw = input.trim();
        if (!raw) return { type: 'empty' };

        // Note: /clips/ pages and gph.is short links are intentionally not matched here.
        // Clips render MP4-only renditions, and short codes are redirects, not media IDs.
        const singlePatterns = [
            /(?:^|https?:\/\/)(?:www\.)?giphy\.com\/gifs\/.*?([a-zA-Z0-9]+)\/?(?:\?.*)?$/i,
            /(?:^|https?:\/\/)(?:www\.)?giphy\.com\/stickers\/.*?([a-zA-Z0-9]+)\/?(?:\?.*)?$/i,
            /(?:^|https?:\/\/)(?:www\.)?giphy\.com\/embed\/([a-zA-Z0-9]+)\/?(?:\?.*)?$/i,
            /(?:^|https?:\/\/)media\d*\.giphy\.com\/media\/([a-zA-Z0-9]+)\/?.*/i,
            /(?:^|https?:\/\/)i\.giphy\.com\/media\/([a-zA-Z0-9]+)\/?.*/i,
            /(?:^|https?:\/\/)i\.giphy\.com\/([a-zA-Z0-9]+)\/?.*/i
        ];
        for (let re of singlePatterns) {
            const m = raw.match(re);
            if (m) {
                let id = m[1];
                if (id && id.length >= 5 && !RESERVED.has(id.toLowerCase())) {
                    return { type: 'single', gifId: id };
                }
            }
        }

        if (raw.includes('giphy.com') && (raw.includes('/gifs/') || raw.includes('/stickers/') || raw.includes('/clips/'))) {
            try {
                const urlObj = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
                const host = urlObj.hostname.toLowerCase();
                if (host !== 'giphy.com' && !host.endsWith('.giphy.com')) return { type: 'invalid' };
                // Clip pages are MP4-only renditions; their IDs don't resolve to a .gif media URL.
                if (urlObj.pathname.toLowerCase().startsWith('/clips')) return { type: 'invalid', reason: 'clips' };
                const lastPart = urlObj.pathname.split('/').filter(Boolean).pop();
                if (lastPart) {
                    const candidate = lastPart.split('-').pop();
                    if (candidate && /^[a-zA-Z0-9]+$/.test(candidate) && candidate.length >= 5) {
                        return { type: 'single', gifId: candidate };
                    }
                }
            } catch (e) {}
        }

        let urlObj = null;
        let toParse = raw;
        if (!/^https?:\/\//i.test(toParse)) {
            if (/^@[a-zA-Z0-9_.-]{2,50}$/.test(toParse)) {
                const clean = toParse.slice(1);
                if (!RESERVED.has(clean.toLowerCase())) {
                    return { type: 'user', username: clean };
                }
            }
            if (!toParse.includes('/') && !toParse.includes('.')) return { type: 'search', query: toParse };
            toParse = 'https://' + toParse;
        }
        try {
            urlObj = new URL(toParse);
        } catch (e) {
            return { type: 'invalid' };
        }

        const host = urlObj.hostname.toLowerCase();
        const isGiphyHost = host === 'giphy.com' || host.endsWith('.giphy.com');
        const isGphHost = host === 'gph.is' || host.endsWith('.gph.is');
        if (!isGiphyHost && !isGphHost) {
            return { type: 'invalid' };
        }
        if (isGphHost) {
            // gph.is links are redirects; the short code is not a media ID.
            return { type: 'invalid', reason: 'shortlink' };
        }

        const parts = urlObj.pathname.split('/').filter(Boolean);
        if (parts.length === 0) {
            return { type: 'invalid' };
        }

        let username = null;
        if (parts[0].toLowerCase() === 'channel' && parts.length >= 2) {
            username = parts[1];
        } else if (parts.length === 1) {
            if (!RESERVED.has(parts[0].toLowerCase())) {
                username = parts[0];
            } else {
                return { type: 'invalid' };
            }
        } else if (parts.length > 1) {
            const first = parts[0];
            if (!RESERVED.has(first.toLowerCase()) && !['gifs','stickers','clips','embed'].includes(first.toLowerCase())) {
                username = first;
            } else {
                return { type: 'invalid' };
            }
        }

        if (username) {
            username = username.replace(/^@/, '').split('?')[0].split('#')[0];
            if (username && /^[a-zA-Z0-9_.-]+$/.test(username) && username.length >= 2) {
                return { type: 'user', username: username };
            }
        }

        return { type: 'invalid' };
    }

    // --- Fetch helpers ---
    async function fetchGifsSearch(query, apiKey, limit, offset, signal) {
        const q = query;
        const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&lang=en`;
        const res = await fetch(url, { signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.meta?.msg || `HTTP ${res.status}`);
        if (data.meta && data.meta.status !== 200) throw new Error(data.meta.msg || 'API error');
        return data;
    }
    async function fetchStickersSearch(username, apiKey, limit, offset, signal) {
        const q = '@' + username;
        const url = `https://api.giphy.com/v1/stickers/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&lang=en`;
        const res = await fetch(url, { signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.meta?.msg || `HTTP ${res.status}`);
        if (data.meta && data.meta.status !== 200) throw new Error(data.meta.msg || 'API error');
        return data;
    }

    // --- Main fetch for user ---
    // Per-type offsets/totals (gifsOffset/gifsTotal/stickersOffset/stickersTotal) live in
    // module state; the fetcher derives the next request from them itself.
    async function fetchUserGifs(username, append) {
        if (!append) {
            cancelPendingRequest();
        } else if (isLoading) {
            return;
        }
        const requestId = ++requestVersion;
        const controller = new AbortController();
        requestController = controller;
        isLoading = true;
        const apiKey = getApiKey();

        // On first load (not append), reset everything
        if (!append) {
            currentUsername = username;
            currentSearchQuery = null;
            currentFilter = 'all';
            $('#content-filter').show();
            $('.content-filter .btn').removeClass('active');
            $('#filter-all').addClass('active');
            gifsOffset = 0;
            stickersOffset = 0;
            gifsTotal = 0;
            stickersTotal = 0;
            loadedGifs = [];
            loadedStickers = [];
            selectedIds.clear();
            $('#gifs-grid').empty();
            $('#user-title').text('@' + username);
            $('#user-subtitle').text('Loading GIFs & Stickers for @' + username + ' ...');
            $('#user-controls').show();
            $('#user-gifs-section').show();
            $('#single-gif-section').hide();
            $('#load-more').hide().text('Load More').prop('disabled', false);
            $('#selection-count').text('0 selected');
            $('#total-count').text('');
            updateFilterBadges();
            showStatus('Fetching GIFs & Stickers for @' + username + ' ...', false);
        } else {
            $('#load-more').text('Loading...').prop('disabled', true);
            showStatus('Loading more...', false);
        }

        try {
            let newGifs = [];
            let newStickers = [];

            if (currentFilter === 'all') {
                // Fetch both in parallel
                const gifsLimit = PAGE_LIMIT_ALL_EACH;
                const stickersLimit = PAGE_LIMIT_ALL_EACH;
                // For append case, use current offsets; for initial, 0
                const gOffset = append ? gifsOffset : 0;
                const sOffset = append ? stickersOffset : 0;

                // If we already know total and offset >= total, skip fetch
                const promises = [];
                const shouldFetchGifs = !append || gOffset < gifsTotal || gifsTotal === 0;
                const shouldFetchStickers = !append || sOffset < stickersTotal || stickersTotal === 0;

                // For initial load, we don't know totals yet, so fetch both
                if (!append || shouldFetchGifs) {
                    promises.push(fetchGifsSearch('@' + username, apiKey, gifsLimit, gOffset, controller.signal).then(d => ({type:'gifs', data:d})).catch(e => ({type:'gifs', error:e})));
                } else {
                    promises.push(Promise.resolve({type:'gifs', data:{data:[], pagination:{total_count:gifsTotal, offset:gOffset, count:0}}}));
                }
                if (!append || shouldFetchStickers) {
                    promises.push(fetchStickersSearch(username, apiKey, stickersLimit, sOffset, controller.signal).then(d => ({type:'stickers', data:d})).catch(e => ({type:'stickers', error:e})));
                } else {
                    promises.push(Promise.resolve({type:'stickers', data:{data:[], pagination:{total_count:stickersTotal, offset:sOffset, count:0}}}));
                }

                const results = await Promise.all(promises);
                if (requestId !== requestVersion) return;
                for (let r of results) {
                    if (r.error) {
                        console.warn(`Failed ${r.type}:`, r.error);
                        // Don't throw, just keep empty; but if both fail, throw
                        if (r.type === 'gifs' && results.every(x => x.error)) throw r.error;
                        // For partial failure, continue
                    } else {
                        if (r.type === 'gifs') {
                            newGifs = r.data.data || [];
                            gifsTotal = r.data.pagination?.total_count ?? gifsTotal;
                            gifsOffset = (r.data.pagination?.offset ?? gOffset) + newGifs.length;
                        } else {
                            newStickers = r.data.data || [];
                            stickersTotal = r.data.pagination?.total_count ?? stickersTotal;
                            stickersOffset = (r.data.pagination?.offset ?? sOffset) + newStickers.length;
                        }
                    }
                }

                // If one of the fetches errored but the other succeeded, we still have partial data; update totals for succeeded
                // Handle case where initial fetch failed for one type but succeeded for other - still show data
                if (newGifs.length === 0 && newStickers.length === 0 && (gifsTotal === 0 && stickersTotal === 0)) {
                    // Both empty
                    if (!append) {
                        $('#user-subtitle').text('No GIFs or Stickers found for @' + username);
                        showStatus('No content found for @' + username + '. Try another username or check API key.', true);
                        $('#load-more').hide();
                        $('#download-selected, #download-all').prop('disabled', true);
                        isLoading = false;
                        updateFilterBadges();
                        return;
                    }
                }

                if (append) {
                    // Drop duplicates that overlap with previously loaded pages.
                    const existing = new Set([...loadedGifs, ...loadedStickers].map(g => g.id));
                    const freshGifs = newGifs.filter(g => !existing.has(g.id));
                    const freshStickers = newStickers.filter(g => !existing.has(g.id));
                    loadedGifs = loadedGifs.concat(freshGifs);
                    loadedStickers = loadedStickers.concat(freshStickers);
                    if (freshGifs.length || freshStickers.length) {
                        // Insert only the new cards in merged order, leaving the existing DOM intact.
                        appendCardsSorted([...freshGifs, ...freshStickers]);
                    }
                } else {
                    loadedGifs = newGifs;
                    loadedStickers = newStickers;
                    renderFiltered();
                }

            } else if (currentFilter === 'gifs') {
                const limit = PAGE_LIMIT_SINGLE;
                const gOffset = append ? gifsOffset : 0;
                const data = await fetchGifsSearch('@' + username, apiKey, limit, gOffset, controller.signal);
                if (requestId !== requestVersion) return;
                newGifs = data.data || [];
                gifsTotal = data.pagination?.total_count ?? gifsTotal;
                gifsOffset = (data.pagination?.offset ?? gOffset) + newGifs.length;
                if (!append && newGifs.length === 0) {
                    $('#user-subtitle').text('No GIFs found for @' + username);
                    showStatus('No GIFs found for @' + username, true);
                    $('#load-more').hide();
                    isLoading = false;
                    updateFilterBadges();
                    return;
                }
                if (append) {
                    const currentIds = new Set(loadedGifs.map(g => g.id));
                    newGifs = newGifs.filter(g => !currentIds.has(g.id));
                }
                loadedGifs = append ? loadedGifs.concat(newGifs) : newGifs;
                if (newGifs.length) renderGifs(newGifs, append);

            } else if (currentFilter === 'stickers') {
                const limit = PAGE_LIMIT_SINGLE;
                const sOffset = append ? stickersOffset : 0;
                const data = await fetchStickersSearch(username, apiKey, limit, sOffset, controller.signal);
                if (requestId !== requestVersion) return;
                newStickers = data.data || [];
                stickersTotal = data.pagination?.total_count ?? stickersTotal;
                stickersOffset = (data.pagination?.offset ?? sOffset) + newStickers.length;
                if (!append && newStickers.length === 0) {
                    $('#user-subtitle').text('No Stickers found for @' + username);
                    showStatus('No Stickers found for @' + username, true);
                    $('#load-more').hide();
                    isLoading = false;
                    updateFilterBadges();
                    return;
                }
                if (append) {
                    const currentStickerIds = new Set(loadedStickers.map(g => g.id));
                    newStickers = newStickers.filter(g => !currentStickerIds.has(g.id));
                }
                loadedStickers = append ? loadedStickers.concat(newStickers) : newStickers;
                if (newStickers.length) renderGifs(newStickers, append);
            }

            updateSubtitle();
            updateLoadMoreVisibility();
            $('#download-selected').prop('disabled', selectedIds.size === 0);
            // Download All should be enabled if filtered has data
            const filtered = getFilteredGifs();
            $('#download-all').prop('disabled', filtered.length === 0);
            if (filtered.length > 0 && currentFilter === 'all') {
                $('#download-all').text(`Download All as ZIP (${filtered.length}/${gifsTotal + stickersTotal})`);
            } else if (filtered.length > 0) {
                $('#download-all').text(`Download All as ZIP (${filtered.length})`);
            } else {
                $('#download-all').text('Download All as ZIP');
            }
            updateSelectionUI();
            showStatus('', false);

        } catch (err) {
            if (err.name === 'AbortError' || requestId !== requestVersion) return;
            console.error(err);
            let msg = err.message || 'Failed to fetch';
            if (msg.toLowerCase().includes('unauthorized') || msg.includes('401') || msg.includes('403')) {
                msg = 'API key error: ' + msg + '. Please set a valid Giphy API key in settings (developers.giphy.com).';
            } else if (msg.includes('429')) {
                msg = 'Rate limited. Please wait or use your own API key.';
            }
            showStatus(msg, true);
            $('#user-subtitle').text('Error loading for @' + username);
            showInfoAlert(msg);
            if (!append) {
                $('#load-more').hide();
            } else {
                $('#load-more').text('Load More').prop('disabled', false);
            }
        } finally {
            if (requestId === requestVersion) {
                isLoading = false;
                requestController = null;
            }
        }
    }

    // --- Main fetch for text search ---
    async function fetchSearchGifs(query, offset, append) {
        if (!append) {
            cancelPendingRequest();
        } else if (isLoading) {
            return;
        }
        const requestId = ++requestVersion;
        const controller = new AbortController();
        requestController = controller;
        isLoading = true;

        if (!append) {
            currentSearchQuery = query;
            currentUsername = null;
            currentFilter = 'gifs';
            gifsOffset = 0;
            stickersOffset = 0;
            gifsTotal = 0;
            stickersTotal = 0;
            loadedGifs = [];
            loadedStickers = [];
            selectedIds.clear();
            $('#content-filter').hide();
            $('#gifs-grid').empty();
            $('#user-title').text(`Search: ${query}`);
            $('#user-subtitle').text(`Searching GIFs for “${query}” ...`);
            $('#user-controls, #user-gifs-section').show();
            $('#single-gif-section').hide();
            $('#load-more').hide().text('Load More').prop('disabled', false);
            $('#selection-count').text('0 selected');
            $('#total-count').text('');
            updateFilterBadges();
            showStatus(`Searching GIFs for “${query}” ...`, false);
        } else {
            $('#load-more').text('Loading...').prop('disabled', true);
            showStatus('Loading more...', false);
        }

        try {
            const gOffset = append ? gifsOffset : 0;
            const data = await fetchGifsSearch(query, getApiKey(), PAGE_LIMIT_SINGLE, gOffset, controller.signal);
            if (requestId !== requestVersion) return;
            let newGifs = data.data || [];
            gifsTotal = data.pagination?.total_count ?? gifsTotal;
            gifsOffset = (data.pagination?.offset ?? gOffset) + newGifs.length;
            if (!append && newGifs.length === 0) {
                $('#user-subtitle').text(`No GIFs found for “${query}”`);
                showStatus(`No GIFs found for “${query}”`, true);
                $('#load-more').hide();
                $('#download-selected, #download-all').prop('disabled', true);
                return;
            }
            if (append) {
                const existingIds = new Set(loadedGifs.map(g => g.id));
                newGifs = newGifs.filter(g => !existingIds.has(g.id));
            }
            loadedGifs = append ? loadedGifs.concat(newGifs) : newGifs;
            if (newGifs.length) renderGifs(newGifs, append);
            updateSubtitle();
            updateLoadMoreVisibility();
            $('#download-all').prop('disabled', loadedGifs.length === 0).text(`Download All as ZIP (${loadedGifs.length})`);
            updateSelectionUI();
            showStatus('', false);
        } catch (err) {
            if (err.name === 'AbortError' || requestId !== requestVersion) return;
            const msg = err.message || 'Failed to search GIFs';
            showStatus(msg, true);
            $('#user-subtitle').text(`Error searching for “${query}”`);
            showInfoAlert(msg);
            $('#load-more').text('Load More').prop('disabled', false);
        } finally {
            if (requestId === requestVersion) {
                isLoading = false;
                requestController = null;
            }
        }
    }

    function hasMoreToLoad() {
        if (currentFilter === 'all') {
            return (gifsOffset < gifsTotal) || (stickersOffset < stickersTotal);
        }
        if (currentFilter === 'gifs') {
            return gifsOffset < gifsTotal;
        }
        if (currentFilter === 'stickers') {
            return stickersOffset < stickersTotal;
        }
        return false;
    }

    function updateLoadMoreVisibility() {
        // Infinite scroll replaces the Load More button.
        $('#load-more').hide();
        checkInfiniteScroll();
    }

    // Shared next-page loader (previously wired to the Load More button).
    function loadNextPage() {
        if (currentSearchQuery) {
            fetchSearchGifs(currentSearchQuery, gifsOffset, true);
            return;
        }
        if (!currentUsername) return;
        fetchUserGifs(currentUsername, true);
    }

    // Loads the next page automatically as the end of the grid approaches the viewport.
    let infiniteScrollTimer = null;
    function checkInfiniteScroll() {
        if (isLoading || !hasMoreToLoad()) return;
        if (!currentSearchQuery && !currentUsername) return;
        const sentinel = document.querySelector('.load-more-wrap');
        if (!sentinel) return;
        const rect = sentinel.getBoundingClientRect();
        // Trigger slightly before the bottom so the next page is ready when the user gets there.
        if (rect.top <= window.innerHeight + 600) {
            loadNextPage();
        }
    }

    function scheduleInfiniteScrollCheck() {
        if (infiniteScrollTimer) return;
        infiniteScrollTimer = setTimeout(function () {
            infiniteScrollTimer = null;
            checkInfiniteScroll();
        }, 200);
    }

    $(window).on('scroll resize', scheduleInfiniteScrollCheck);

    function renderFiltered() {
        $('#gifs-grid').empty();
        getFilteredGifs().forEach(gif => $('#gifs-grid').append(createGifCard(gif)));
    }

    function createGifCard(gif) {
        const id = String(gif.id || '');
        const title = String(gif.title || id || 'Untitled');
        const isSticker = gif.is_sticker === 1 || gif.type === 'sticker';
        const directLink = gif.images?.original?.url || `https://media.giphy.com/media/${encodeURIComponent(id)}/giphy.gif`;
        // Prefer a ~320px-wide rendition: the 100px "small" ones get upscaled
        // 2-3x at card size and look pixelated.
        const previewUrl = gif.images?.downsized_medium?.url
            || gif.images?.fixed_height?.url
            || gif.images?.fixed_width?.url
            || gif.images?.preview_gif?.url
            || directLink;
        const card = $('<div>', { class: 'gif-card' }).attr({ 'data-id': id, 'data-url': directLink, 'data-import': String(Date.parse(gif.import_datetime) || 0) });
        const imageWrap = $('<div>', { class: 'gif-card-img-wrap' });
        const checkbox = $('<input>', { type: 'checkbox', class: 'gif-card-checkbox' }).attr('data-id', id).prop('checked', selectedIds.has(id));
        const image = $('<img>', { alt: title, loading: 'lazy' }).attr('src', previewUrl);
        if (isSticker) image.addClass('is-sticker');
        const badge = $('<span>', { class: 'gif-card-badge' }).text(isSticker ? 'Sticker' : 'GIF');
        if (isSticker) badge.addClass('sticker');
        const cardTitle = $('<p>', { class: 'gif-card-title', title: title }).text(title);
        const copyButton = $('<button>', { type: 'button', class: 'btn btn-sm btn-outline-primary btn-copy' }).attr({ 'data-id': id, 'data-url': directLink }).text('Copy Link');
        const downloadButton = $('<button>', { type: 'button', class: 'btn btn-sm btn-success btn-download' }).attr({ 'data-id': id, 'data-url': directLink }).text('Download');
        const actions = $('<div>', { class: 'gif-card-actions' }).append(copyButton, downloadButton);
        const body = $('<div>', { class: 'gif-card-body' }).append(cardTitle, actions);
        imageWrap.append(checkbox, image, badge);
        card.append(imageWrap, body);
        if (selectedIds.has(id)) card.addClass('selected');
        return card;
    }

    function renderGifs(gifs, append) {
        if (!append && currentFilter !== 'all') $('#gifs-grid').empty();
        if (currentFilter === 'all') return;
        gifs.forEach(gif => $('#gifs-grid').append(createGifCard(gif)));
    }

    // Inserts new cards into the 'all' grid, keeping the combined newest-first order
    // without rebuilding the whole grid (avoids image reloads/flicker on page appends).
    function appendCardsSorted(newItems) {
        const grid = document.getElementById('gifs-grid');
        let children = Array.prototype.slice.call(grid.children);
        newItems.forEach(function (gif) {
            const $card = createGifCard(gif);
            const t = Number($card.attr('data-import')) || 0;
            // Cards are ordered newest-first; new pages are usually older, so scan from the end.
            let i = children.length;
            while (i > 0 && (Number($(children[i - 1]).attr('data-import')) || 0) < t) i--;
            const node = $card[0];
            grid.insertBefore(node, children[i] || null);
            children.splice(i, 0, node);
        });
    }


    function updateSelectionUI() {
        const filtered = getFilteredGifs();
        const visibleIds = new Set(filtered.map(g => g.id));
        const countVisible = Array.from(selectedIds).filter(id => visibleIds.has(id)).length;
        const totalSelected = selectedIds.size;
        $('#selection-count').text(`${countVisible} selected${totalSelected !== countVisible ? ` (${totalSelected} total)` : ''} / ${filtered.length} visible`);
        // Download Selected must be 0 until user explicitly clicks Select All or checks boxes — never auto-set to 309
        $('#download-selected').prop('disabled', totalSelected === 0);
        if (totalSelected > 0) {
            $('#download-selected').text(`Download Selected as ZIP (${totalSelected})`);
        } else {
            $('#download-selected').text('Download Selected as ZIP (0)');
        }
        $('.gif-card').each(function(){
            const id = $(this).data('id');
            if (selectedIds.has(id)) {
                $(this).addClass('selected');
                $(this).find('.gif-card-checkbox').prop('checked', true);
            } else {
                $(this).removeClass('selected');
                $(this).find('.gif-card-checkbox').prop('checked', false);
            }
        });
    }

    // --- ZIP Download ---
    async function downloadAsZip(gifsToDownload, zipName) {
        if (!gifsToDownload || gifsToDownload.length === 0) {
            showInfoAlert('No GIFs to download');
            return;
        }
        // Fall back to other renditions when the original size byte field is missing,
        // otherwise the large-batch confirm dialog would silently never trigger.
        const gifSize = (gif) => Number(gif.images?.original?.size)
            || Number(gif.images?.downsized?.size)
            || Number(gif.images?.downsized_large?.size)
            || 0;
        const estimatedBytes = gifsToDownload.reduce((total, gif) => total + gifSize(gif), 0);
        if (gifsToDownload.length > MAX_ZIP_ITEMS) {
            showInfoAlert(`ZIP downloads are limited to ${MAX_ZIP_ITEMS} items. Select a smaller batch to avoid exhausting browser memory.`);
            return;
        }
        // Large-but-allowed batches get a size warning instead of a hard refusal.
        const SOFT_SIZE_LIMIT = 900 * 1024 * 1024; // ~900 MB of estimated GIF data
        if (estimatedBytes > SOFT_SIZE_LIMIT) {
            const estimatedMb = Math.round(estimatedBytes / (1024 * 1024));
            const ok = confirm(`This ZIP bundles about ${estimatedMb} MB across ${gifsToDownload.length} items, which can slow your browser or exhaust its memory. Continue?`);
            if (!ok) return;
        }
        if (typeof JSZip === 'undefined' || typeof saveAs === 'undefined') {
            showStatus('ZIP library not loaded. Try individual downloads.', true);
            return;
        }
        $('#zip-progress').show();
        $('#zip-progress-bar').css('width','0%').text('0%');
        const estimatedSize = estimatedBytes ? ` (about ${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB)` : '';
        $('#zip-progress-text').text(`Preparing ZIP with ${gifsToDownload.length} items${estimatedSize}...`);
        $('#download-selected, #download-all, #load-more, #select-all, #deselect-all').prop('disabled', true);

        const zip = new JSZip();
        let completed = 0;
        let failed = 0;

        let nextIndex = 0;
        const downloadOne = async function () {
            while (nextIndex < gifsToDownload.length) {
                const index = nextIndex++;
                const gif = gifsToDownload[index];
                const id = gif.id;
                const url = gif.images?.original?.url || gif.directLink || `https://media.giphy.com/media/${id}/giphy.gif`;
                const ext = (gif.type === 'sticker' || gif.is_sticker === 1) ? '-sticker.gif' : '.gif';
                const filename = `${id}${ext}`;
                $('#zip-progress-text').text(`Downloading ${index + 1}/${gifsToDownload.length}: ${filename} ...`);
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    zip.file(filename, await response.arrayBuffer());
                    completed++;
                } catch (e) {
                    console.warn('Failed to fetch', url, e);
                    failed++;
                }
                const processed = completed + failed;
                const pct = Math.round((processed / gifsToDownload.length) * 100);
                $('#zip-progress-bar').css('width', pct + '%').text(pct + '%');
            }
        };
        await Promise.all(Array.from({ length: Math.min(ZIP_CONCURRENCY, gifsToDownload.length) }, downloadOne));

        $('#zip-progress-text').text('Generating ZIP file...');
        try {
            // GIFs are already compressed; STORE avoids a second in-memory copy
            // and lets much larger batches fit in browser memory.
            const content = await zip.generateAsync({type:"blob", compression:"STORE"}, function(metadata) {
                const pct = Math.round(metadata.percent);
                $('#zip-progress-bar').css('width', pct+'%').text(pct+'%');
                $('#zip-progress-text').text(`Compressing: ${pct}%`);
            });
            saveAs(content, zipName);
            showInfoAlert(`ZIP downloaded: ${completed} succeeded${failed ? ', '+failed+' failed' : ''}`);
            showStatus(`ZIP created with ${completed} items${failed ? ' ('+failed+' failed)' : ''}`, false);
        } catch(e) {
            console.error(e);
            showStatus('Failed to generate ZIP: '+e.message, true);
            showInfoAlert('ZIP generation failed');
        } finally {
            setTimeout(()=>{ $('#zip-progress').hide(); }, 2000);
            $('#download-selected, #download-all, #load-more, #select-all, #deselect-all').prop('disabled', false);
            updateSelectionUI();
            updateLoadMoreVisibility();
        }
    }

    async function downloadSingleFile(url, filename) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP '+res.status);
            const blob = await res.blob();
            if (typeof saveAs !== 'undefined') {
                saveAs(blob, filename);
            } else {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 100);
            }
        } catch(e) {
            window.open(url, '_blank');
            showInfoAlert('Direct download failed, opened in new tab. Right-click to save.');
        }
    }

    function getDownloadPrefix() {
        const source = currentUsername || currentSearchQuery || 'giphy';
        return source.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'giphy';
    }

    // --- Events ---
    $("#copy").on('click', function () {
        const val = $("#direct-gif-link").val();
        if (!val) { showInfoAlert('No link to copy'); return; }
        copyToClipboard(val);
    });

    // Download single GIF via fetch + saveAs: the `download` attribute is ignored for
    // cross-origin URLs, so a plain link would just open the file in a new tab.
    $('#download-single').on('click', function (e) {
        e.preventDefault();
        const href = $(this).attr('href');
        if (!href || href === '#') return;
        downloadSingleFile(href, $(this).attr('download') || 'giphy.gif');
    });

    $("#clear-input").on('click', function () {
        $('#giphyLink').val('').trigger('change');
        showDefaultPreview();
    });

    // Filter tabs
    $('.content-filter .btn').on('click', function() {
        if (currentSearchQuery) return;
        const filter = $(this).data('filter');
        if (filter === currentFilter) return;
        currentFilter = filter;
        $('.content-filter .btn').removeClass('active');
        $(this).addClass('active');
        // Re-render with current data
        renderFiltered();
        updateSubtitle();
        updateLoadMoreVisibility();
        updateSelectionUI();
        // If switching to a filter that has no data yet but total suggests data, fetch
        if (currentFilter === 'gifs' && loadedGifs.length === 0 && gifsTotal > 0) {
            fetchUserGifs(currentUsername, true);
        } else if (currentFilter === 'stickers' && loadedStickers.length === 0 && stickersTotal > 0) {
            fetchUserGifs(currentUsername, true);
        } else if (currentFilter === 'all' && (loadedGifs.length === 0 || loadedStickers.length === 0) && currentUsername) {
            // If all and one type missing, refetch all? For now just render what we have
        }
    });

    // User controls
    $('#select-all').on('click', function() {
        const filtered = getFilteredGifs();
        filtered.forEach(g => selectedIds.add(g.id));
        updateSelectionUI();
    });
    $('#deselect-all').on('click', function() {
        const filtered = getFilteredGifs();
        // Deselect only visible if filter is not all? For all, deselect all globally
        if (currentFilter === 'all') {
            selectedIds.clear();
        } else {
            filtered.forEach(g => selectedIds.delete(g.id));
        }
        updateSelectionUI();
    });
    $('#download-selected').on('click', function() {
        // Download selected across all loaded? Use selectedIds globally
        const allLoaded = [...loadedGifs, ...loadedStickers];
        const toDownload = allLoaded.filter(g => selectedIds.has(g.id));
        if (toDownload.length === 0) { showInfoAlert('Select at least one item'); return; }
        const name = getDownloadPrefix() + `_selected_${toDownload.length}.zip`;
        downloadAsZip(toDownload, name);
    });
    let autoLoadingAll = false;
    $('#download-all').on('click', async function() {
        const filtered = getFilteredGifs();
        if (filtered.length === 0) return;
        // If not all loaded, offer to load all first; otherwise download what's loaded
        const total = currentFilter === 'all' ? (gifsTotal + stickersTotal) : (currentFilter === 'gifs' ? gifsTotal : stickersTotal);
        const hasMore = filtered.length < total;

        if (hasMore) {
            const capNote = total > MAX_ZIP_ITEMS ? ` (ZIP limit is ${MAX_ZIP_ITEMS}; only the first ${MAX_ZIP_ITEMS} will be downloaded)` : '';
            if (!confirm(`Not all items are loaded (${filtered.length} of ${total} shown). Download only loaded ${filtered.length}? Click OK to download loaded, or Cancel to first load all${capNote}.`)) {
                // User wants to load all before download - auto load all
                if (autoLoadingAll) return;
                autoLoadingAll = true;
                try {
                    showInfoAlert('Loading all remaining items before ZIP...');
                    // Auto paginate, with failure detection so a persistent API error
                    // (e.g. rate limiting) cannot spin this loop forever.
                    let noProgress = 0;
                    let iterations = 0;
                    while ((currentFilter === 'all' && (gifsOffset < gifsTotal || stickersOffset < stickersTotal)) ||
                           (currentFilter === 'gifs' && gifsOffset < gifsTotal) ||
                           (currentFilter === 'stickers' && stickersOffset < stickersTotal)) {
                        // Stop once we already have as much as a ZIP can hold
                        if ((currentFilter === 'all' ? loadedGifs.length + loadedStickers.length : getFilteredGifs().length) >= MAX_ZIP_ITEMS) break;
                        if (++iterations > 400) break; // hard safety net
                        const beforeOffset = currentFilter === 'all' ? (gifsOffset + stickersOffset) : (currentFilter === 'gifs' ? gifsOffset : stickersOffset);
                        const beforeCount = currentFilter === 'all' ? (loadedGifs.length + loadedStickers.length) : getFilteredGifs().length;
                        if (currentSearchQuery) {
                            await fetchSearchGifs(currentSearchQuery, gifsOffset, true);
                        } else {
                            await fetchUserGifs(currentUsername, true);
                        }
                        // Small delay to avoid rate limit
                        await new Promise(r => setTimeout(r, 300));
                        if (isLoading) break;
                        const afterOffset = currentFilter === 'all' ? (gifsOffset + stickersOffset) : (currentFilter === 'gifs' ? gifsOffset : stickersOffset);
                        const afterCount = currentFilter === 'all' ? (loadedGifs.length + loadedStickers.length) : getFilteredGifs().length;
                        if (afterOffset === beforeOffset && afterCount === beforeCount) {
                            // Nothing was fetched (error or exhausted) — give up after a few attempts
                            if (++noProgress >= 3) {
                                showInfoAlert('Stopped loading after repeated failures. Downloading what is loaded.');
                                break;
                            }
                        } else {
                            noProgress = 0;
                        }
                    }
                    let updatedFiltered = getFilteredGifs();
                    if (updatedFiltered.length > MAX_ZIP_ITEMS) {
                        updatedFiltered = updatedFiltered.slice(0, MAX_ZIP_ITEMS);
                        showInfoAlert(`Batch capped at ${MAX_ZIP_ITEMS} items (ZIP limit).`);
                    }
                    const name2 = `${getDownloadPrefix()}_${currentFilter}_${updatedFiltered.length}.zip`;
                    downloadAsZip(updatedFiltered, name2);
                } finally {
                    autoLoadingAll = false;
                }
                return;
            }
        }
        const name = `${getDownloadPrefix()}_${currentFilter}_${filtered.length}.zip`;
        downloadAsZip(filtered, name);
    });
    // Grid delegation
    $('#gifs-grid').on('change', '.gif-card-checkbox', function(e) {
        e.stopPropagation();
        const id = $(this).data('id');
        if ($(this).is(':checked')) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSelectionUI();
    });
    $('#gifs-grid').on('click', '.gif-card-img-wrap', function(e) {
        if ($(e.target).is('input')) return;
        const card = $(this).closest('.gif-card');
        const id = card.data('id');
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        updateSelectionUI();
    });
    $('#gifs-grid').on('click', '.btn-copy', function(e) {
        e.stopPropagation();
        const url = $(this).data('url');
        copyToClipboard(url);
    });
    $('#gifs-grid').on('click', '.btn-download', async function(e) {
        e.stopPropagation();
        const url = $(this).data('url');
        const id = $(this).data('id');
        await downloadSingleFile(url, id + '.gif');
    });

    // Input handling with debounce
    let lastHandledInput = null;
    let lastHandledAt = 0;
    function handleInput() {
        const val = $('#giphyLink').val().trim();
        if (!val) {
            showDefaultPreview();
            return;
        }
        // Skip identical repeat triggers (e.g. Enter keydown → keyup / change re-fire) within a short window.
        if (val === lastHandledInput && Date.now() - lastHandledAt < 1200) return;
        lastHandledInput = val;
        lastHandledAt = Date.now();
        const parsed = parseGiphyUrl(val);

        if (parsed.type === 'empty') {
            showDefaultPreview();
            return;
        }
        if (parsed.type === 'single') {
            const gifDirectLink = 'https://media.giphy.com/media/' + parsed.gifId + '/giphy.gif';
            showSingleGif(parsed.gifId, gifDirectLink);
            return;
        }
        if (parsed.type === 'user') {
            fetchUserGifs(parsed.username, false);
            return;
        }
        if (parsed.type === 'search') {
            fetchSearchGifs(parsed.query, 0, false);
            return;
        }
        if (parsed.type === 'invalid') {
            resetViews();
            $('#single-gif-section').hide();
            $('#user-gifs-section').hide();
            if (parsed.reason === 'shortlink') {
                showStatus("Giphy short links (gph.is) can't be expanded here. Open the link in your browser and copy the full giphy.com URL from the address bar.", true);
            } else if (parsed.reason === 'clips') {
                showStatus('Giphy Clips links are not supported (Clips are MP4-only). Try a GIF or Sticker link, a search, or a profile URL.', true);
            } else {
                showStatus('Invalid URL. Paste a Giphy link, use a Giphy profile URL, or type a GIF search.', true);
            }
            return;
        }
    }

    $("#giphyLink").on("change paste keyup", function (e) {
        // Enter is handled immediately on keydown; its keyup must not re-arm the debounce
        if (e.type === 'keyup' && e.key === 'Enter') return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleInput, 600);
    });
    $("#giphyLink").on("paste", function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleInput, 300);
    });
    $("#giphyLink").on("keydown", function(e) {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            handleInput();
        }
    });

    // Init
    initApiKeyUI();
    showDefaultPreview();

    window.GiphyDownloader = {
        parseGiphyUrl,
        fetchUserGifs,
        getApiKey
    };
});
