// ==UserScript==
// @name         Pokémon TCG SG Event Search – Map
// @namespace    https://github.com/dgallitelli
// @version      1.0.1
// @description  Shows a Google Maps–tiled map of the event search results below the search bar (no API key).
// @match        https://asia.pokemon-card.com/sg/event-search/search*
// @homepageURL  https://github.com/dgallitelli/pokemon-event-map
// @downloadURL  https://raw.githubusercontent.com/dgallitelli/pokemon-event-map/main/pokemon-event-map.user.js
// @updateURL    https://raw.githubusercontent.com/dgallitelli/pokemon-event-map/main/pokemon-event-map.user.js
// @require      https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
// @resource     LEAFLET_CSS https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @connect      www.onemap.gov.sg
// @connect      nominatim.openstreetmap.org
// @connect      asia.pokemon-card.com
// ==/UserScript==

(function () {
  'use strict';

  const SG_CENTER = [1.3521, 103.8198];
  const CACHE_KEY = 'geocache_v1';
  const NOMINATIM_DELAY_MS = 1100; // Nominatim usage policy: max 1 req/s

  const results = document.querySelector('.searchResult');
  const eventLinks = [...document.querySelectorAll('.eventList a.eventLink')];
  if (!results || !eventLinks.length) return;

  GM_addStyle(GM_getResourceText('LEAFLET_CSS'));
  GM_addStyle(`
    #pkm-map-wrap { margin: 16px auto; max-width: 1000px; }
    #pkm-map { height: 420px; border-radius: 8px; border: 1px solid #ddd; }
    #pkm-map-status { font-size: 12px; color: #666; margin-top: 4px; }
    .pkm-popup a { color: #1a5fb4; }
    .pkm-popup ul { margin: 4px 0 0; padding-left: 16px; max-height: 180px; overflow-y: auto; }
  `);

  const wrap = document.createElement('div');
  wrap.id = 'pkm-map-wrap';
  wrap.innerHTML = '<div id="pkm-map"></div><div id="pkm-map-status"></div>';
  results.parentNode.insertBefore(wrap, results);
  const status = wrap.querySelector('#pkm-map-status');

  const map = L.map('pkm-map').setView(SG_CENTER, 11);
  L.tileLayer('https://{s}.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}', {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    maxZoom: 20,
    attribution: 'Map data &copy; Google',
  }).addTo(map);

  // Leaflet's default marker PNGs resolve relative to its CSS file, which breaks when the CSS
  // is injected inline; use a self-contained SVG pin instead.
  const pinIcon = L.divIcon({
    className: '',
    iconSize: [27, 43],
    iconAnchor: [13.5, 43],
    popupAnchor: [0, -38],
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="27" height="43" viewBox="0 0 27 43">' +
      '<path d="M13.5 0C6 0 0 6 0 13.5 0 23.6 13.5 43 13.5 43S27 23.6 27 13.5C27 6 21 0 13.5 0z" fill="#EA4335" stroke="#A52714" stroke-width="1"/>' +
      '<circle cx="13.5" cy="13.5" r="4.8" fill="#3B0A06"/></svg>',
  });

  const cache = GM_getValue(CACHE_KEY, {});
  const saveCache = () => GM_setValue(CACHE_KEY, cache);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function request(url, responseType = 'json') {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType,
        timeout: 15000,
        onload: (r) => resolve(r.status === 200 ? r.response : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // OneMap (Singapore gov) resolves 6-digit postal codes precisely without a token.
  // It drops keyless requests that arrive in bursts, so pace calls and retry once.
  async function oneMap(postal) {
    const url = 'https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=N&pageNum=1&searchVal=' + postal;
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(attempt ? 1500 : 400);
      const r = await request(url);
      const hit = r && r.results && r.results[0];
      if (hit) return [parseFloat(hit.LATITUDE), parseFloat(hit.LONGITUDE)];
    }
    return null;
  }

  let lastNominatim = 0;
  async function nominatim(q) {
    const wait = lastNominatim + NOMINATIM_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=sg&q=' + encodeURIComponent(q);
    const r = await request(url);
    return r && r[0] ? [parseFloat(r[0].lat), parseFloat(r[0].lon)] : null;
  }

  // Unit numbers, floors and parentheticals confuse geocoders; drop them.
  function cleanAddress(addr) {
    return addr
      .replace(/#\s*[\w-]+/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(level|lvl|unit)\s*[\w-]+/gi, '')
      .replace(/\bsingapore\s*\d{6}\b/gi, '')
      .replace(/\bsingapore\b/gi, '')
      .replace(/\s+,/g, ',')
      .replace(/,+/g, ',')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,]+|[\s,]+$/g, '');
  }

  async function geocode(addr) {
    if (addr in cache) return cache[addr];
    let pos = null;
    const postal = addr.match(/(?:^|\D)(\d{6})(?!\d)/); // also matches "S150122"
    if (postal) pos = await oneMap(postal[1]);
    if (!pos) {
      const cleaned = cleanAddress(addr);
      const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);
      // Try the full address, then street-looking parts (contain a number), then the building name.
      const candidates = [cleaned, ...parts.filter((p) => /\d/.test(p)), parts[0]];
      for (const q of [...new Set(candidates)]) {
        if (!q || q.length < 4) continue;
        pos = await nominatim(q);
        if (pos) break;
      }
    }
    if (pos) { cache[addr] = pos; saveCache(); } // don't cache misses: they may be transient
    return pos;
  }

  // Some listings say "Refer to venue address"; the detail page has the real one in its Maps link.
  async function addressFromDetail(href) {
    const key = 'detail:' + href;
    if (key in cache) return cache[key];
    const html = await request(new URL(href, location.origin).href, 'text');
    const m = html && html.match(/maps\/search\/\?api=1&(?:amp;)?query=([^"]+)"/);
    const addr = m ? new DOMParser().parseFromString(m[1], 'text/html').documentElement.textContent.trim() : null;
    cache[key] = addr && !/refer to/i.test(addr) ? addr : null;
    saveCache();
    return cache[key];
  }

  const text = (el, sel) => (el.querySelector(sel)?.textContent || '').trim();
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function run() {
    const events = eventLinks.map((a) => ({
      href: a.href,
      date: text(a, '.eventDate'),
      time: text(a, '.eventTime'),
      title: text(a, '.eventTitle'),
      organizer: text(a, '.organizer'),
      place: text(a, '.place'),
    }));

    for (const ev of events) {
      if (!ev.place || /refer to/i.test(ev.place)) ev.place = (await addressFromDetail(ev.href)) || '';
    }

    const byPlace = new Map();
    for (const ev of events.filter((e) => e.place)) {
      if (!byPlace.has(ev.place)) byPlace.set(ev.place, []);
      byPlace.get(ev.place).push(ev);
    }

    const bounds = [];
    const missing = [];
    let done = 0;
    for (const [place, evs] of byPlace) {
      status.textContent = `Locating venues… ${++done}/${byPlace.size}`;
      const pos = await geocode(place);
      if (!pos) { missing.push(place); continue; }
      bounds.push(pos);
      const items = evs.map((e) =>
        `<li><a href="${esc(e.href)}">${esc(e.date)} ${esc(e.time)} – ${esc(e.title)}</a></li>`).join('');
      const gmaps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place);
      L.marker(pos, { icon: pinIcon }).addTo(map).bindPopup(
        `<div class="pkm-popup"><b>${esc(evs[0].organizer)}</b><br>${esc(place)}<br>` +
        `<a href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a><ul>${items}</ul></div>`);
      if (bounds.length === 1) map.setView(pos, 13);
      else map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }

    const noAddr = events.length - [...byPlace.values()].flat().length;
    status.textContent = `${bounds.length} venue(s) shown for ${events.length} event(s) on this page.` +
      (missing.length ? ` Could not locate: ${missing.join(' | ')}.` : '') +
      (noAddr ? ` ${noAddr} event(s) have no address.` : '');
  }

  run();
})();
