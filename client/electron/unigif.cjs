// UNIGIF — свой сервер GIF (https://github.com/TimurSl/unigif) вместо сохранённых GIF Telegram.
//
// Рендерер никогда не видит API-ключ. Все запросы идут на тот же origin
// (app://telegram/ethernet/unigif/...), а main пересылает их на сервер UNIGIF
// и сам добавляет заголовок Authorization. Так соблюдается CSP клиента
// (media-src 'self', connect-src 'self') и не нужен CORS.
//
// Плагины работают в той же странице, поэтому API-маршруты требуют токен сессии.
// Его выдаёт только IPC (для плагинов — за разрешением desktop.ipc).
// Медиа (/m/...) токена не требуют: <video src> не умеет слать заголовки,
// а ID файлов неугадываемы и известны только через API.

const crypto = require('crypto');
const { ipcMain, net } = require('electron');
const ethernetSettings = require('./ethernet-settings.cjs');

const ROUTE_PREFIX = '/ethernet/unigif';
const TOKEN_HEADER = 'x-ethernet-unigif-token';
const TOKEN_QUERY = 'ethernet_token';
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 10_000;

const GIF_ID = '[A-Za-z0-9_-]{6,32}';

// Только то, что нужно клиенту с ключом `read upload`
const API_ROUTES = [
  { method: 'GET', pattern: /^\/api\/v1\/gifs$/ },
  { method: 'POST', pattern: /^\/api\/v1\/gifs$/, isUpload: true },
  { method: 'GET', pattern: new RegExp(`^/api/v1/gifs/${GIF_ID}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/v1/gifs/${GIF_ID}/use$`) },
  { method: 'GET', pattern: /^\/api\/v1\/tags\/suggest$/ },
  { method: 'GET', pattern: /^\/api\/v1\/events$/, isStream: true },
];
const MEDIA_PATTERN = new RegExp(`^/m/${GIF_ID}/[A-Za-z0-9_.-]{1,40}$`);

const FORWARDED_REQUEST_HEADERS = ['range', 'if-none-match', 'if-modified-since', 'content-type', 'accept', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified',
  'cache-control', 'location', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after',
];

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid server URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server URL must start with http:// or https://');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function getPublicConfig() {
  const { enabled, baseUrl, apiKey } = ethernetSettings.getUnigifSettings();
  return {
    isEnabled: Boolean(enabled && baseUrl && apiKey),
    isSwitchedOn: Boolean(enabled),
    baseUrl: baseUrl || '',
    hasApiKey: Boolean(apiKey),
    token: SESSION_TOKEN,
  };
}

function problem(status, title) {
  return new Response(JSON.stringify({ title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json; charset=utf-8' },
  });
}

function isUnigifRoute(pathname) {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`);
}

async function handleUnigifRequest(request, url) {
  const upstreamPath = url.pathname.slice(ROUTE_PREFIX.length);
  const method = request.method.toUpperCase();
  const isMedia = (method === 'GET' || method === 'HEAD') && MEDIA_PATTERN.test(upstreamPath);
  const route = isMedia ? undefined : API_ROUTES.find((r) => r.method === method && r.pattern.test(upstreamPath));
  if (!isMedia && !route) {
    return problem(404, 'Not proxied');
  }

  if (route) {
    const token = request.headers.get(TOKEN_HEADER) || url.searchParams.get(TOKEN_QUERY);
    if (token !== SESSION_TOKEN) {
      return problem(403, 'Missing Ethernet session token');
    }
  }

  const { enabled, baseUrl, apiKey } = ethernetSettings.getUnigifSettings();
  if (!enabled || !baseUrl || !apiKey) {
    return problem(503, 'UNIGIF is not configured');
  }

  const search = new URLSearchParams(url.search);
  search.delete(TOKEN_QUERY);
  const query = search.toString();
  const target = `${baseUrl}${upstreamPath}${query ? `?${query}` : ''}`;

  const headers = { authorization: `Bearer ${apiKey}` };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  const init = { method, headers, redirect: 'follow' };
  if (route && route.isUpload) {
    init.body = Buffer.from(await request.arrayBuffer());
  }
  if (!route || !route.isStream) {
    init.signal = AbortSignal.timeout(route && route.isUpload ? UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS);
  }

  let upstream;
  try {
    upstream = await net.fetch(target, init);
  } catch (err) {
    console.warn('[unigif] upstream request failed:', err.message);
    return problem(502, `UNIGIF is unreachable: ${err.message}`);
  }

  const responseHeaders = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  if (route && route.isStream) {
    responseHeaders['cache-control'] = 'no-cache';
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function testConnection(candidate) {
  const saved = ethernetSettings.getUnigifSettings();
  const baseUrl = normalizeBaseUrl(candidate && candidate.baseUrl !== undefined ? candidate.baseUrl : saved.baseUrl);
  const apiKey = candidate && candidate.apiKey ? String(candidate.apiKey).trim() : saved.apiKey;
  if (!baseUrl || !apiKey) {
    return { ok: false, error: 'Server URL and API key are required' };
  }

  try {
    const response = await net.fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: body.detail || body.title || `HTTP ${response.status}` };
    }
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    const missing = ['read', 'upload'].filter((s) => !scopes.includes(s));
    return {
      ok: missing.length === 0,
      name: body.name,
      scopes,
      error: missing.length ? `Key is missing scope: ${missing.join(', ')}` : undefined,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function registerUnigifHandlers() {
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      const senderUrl = event.senderFrame?.url || '';
      if (!senderUrl.startsWith('app://telegram/')) {
        console.warn(`[Security] Blocked unauthorized IPC call to '${channel}' from '${senderUrl}'`);
        throw new Error('Unauthorized');
      }
      return fn(event, ...args);
    });
  };

  handle('ethernet:unigif-get-config', () => getPublicConfig());

  handle('ethernet:unigif-set-config', (_e, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('bad unigif config');
    const update = {};
    if (patch.baseUrl !== undefined) update.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) update.apiKey = patch.apiKey.trim();
    if (patch.shouldClearApiKey) update.apiKey = '';
    if (patch.isEnabled !== undefined) update.enabled = Boolean(patch.isEnabled);
    ethernetSettings.setUnigifSettings(update);
    return getPublicConfig();
  });

  handle('ethernet:unigif-test', (_e, candidate) => testConnection(candidate));
}

module.exports = {
  isUnigifRoute,
  handleUnigifRequest,
  registerUnigifHandlers,
};
