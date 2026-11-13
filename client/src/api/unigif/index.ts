import type { UnigifPublicConfig } from '../../types/ethernet';
import type { ApiAttachment, ApiExternalGifSource, ApiVideo } from '../types';

// Requests go to the Electron main process, which forwards them to the UNIGIF server with the API key
const PROXY_PREFIX = '/ethernet/unigif';
const TOKEN_HEADER = 'X-Ethernet-Unigif-Token';
const TOKEN_QUERY = 'ethernet_token';

const VIDEO_ID_PREFIX = 'unigif-';
const FILE_NAME_PREFIX = 'unigif-';
const FILE_NAME_PATTERN = /^unigif-([A-Za-z0-9_-]+)\.mp4$/;
const TELEGRAM_DOCUMENT_ID_PATTERN = /^\d+$/;
const MEDIA_PATH_MARKER = '/m/';
const READY_STATUS = 'ready';
const PAGE_LIMIT = 50;
const UPLOAD_WAIT_SECONDS = 20;
const MS_PER_SECOND = 1000;
const EVENTS_RETRY_MIN_MS = 2000;
const EVENTS_RETRY_MAX_MS = 60000;
const LIVE_EVENT_TYPES = new Set<UnigifEventType>(['gif.added', 'gif.ready', 'gif.tagged', 'gif.deleted', 'resync']);

export type UnigifEventType = 'gif.added' | 'gif.ready' | 'gif.failed' | 'gif.tagged' | 'gif.deleted' | 'resync';

export type UnigifAddResult = {
  id: string;
  gif?: ApiVideo;
  isDuplicate?: boolean;
};

type UnigifMediaFile = {
  url: string;
  width?: number;
  height?: number;
  bytes: number;
};

type UnigifGif = {
  id: string;
  status: 'processing' | 'ready' | 'failed';
  width?: number;
  height?: number;
  duration_ms?: number;
  duplicate?: boolean;
  media?: {
    mp4?: UnigifMediaFile;
    preview_mp4?: UnigifMediaFile;
    poster?: UnigifMediaFile;
  };
};

type UnigifGifPage = {
  items: UnigifGif[];
  next_cursor?: string;
};

type UnigifProblem = {
  title?: string;
  detail?: string;
};

export class UnigifRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let config: UnigifPublicConfig | undefined;
let configPromise: Promise<UnigifPublicConfig | undefined> | undefined;

// Telegram copies of UNIGIF GIFs sent in this session. The worker keeps their documents in `localDb`
// only for the session, so the map lives in memory too.
const telegramVideoByUnigifId = new Map<string, ApiVideo>();

export function loadUnigifConfig(force?: boolean) {
  if (!configPromise || force) {
    const getConfig = window.ethernetDesktop?.unigifGetConfig;
    configPromise = (getConfig ? getConfig() : Promise.resolve(undefined))
      .then((result) => {
        config = result;
        return result;
      })
      .catch(() => undefined);
  }

  return configPromise;
}

export function updateUnigifConfigCache(newConfig: UnigifPublicConfig) {
  config = newConfig;
  configPromise = Promise.resolve(newConfig);
}

export async function checkIsUnigifEnabled() {
  return Boolean((await loadUnigifConfig())?.isEnabled);
}

export function isUnigifVideo(video: ApiVideo): video is ApiVideo & { externalSource: ApiExternalGifSource } {
  return video.externalSource?.provider === 'unigif';
}

export async function fetchUnigifGifs({ query, cursor }: { query?: string; cursor?: string }) {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    status: READY_STATUS,
    sort: 'used',
  });
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);

  const page = await requestUnigif<UnigifGifPage>(`/api/v1/gifs?${params.toString()}`);
  if (!page) return undefined;

  return {
    gifs: page.items.map(buildApiVideoFromUnigif).filter(Boolean),
    nextCursor: page.next_cursor || undefined,
  };
}

export async function fetchUnigifGif(id: string) {
  const gif = await requestUnigif<UnigifGif>(`/api/v1/gifs/${encodeURIComponent(id)}`);
  return gif ? buildApiVideoFromUnigif(gif) : undefined;
}

export async function addUnigifGif(blob: Blob, sourceId: string): Promise<UnigifAddResult | undefined> {
  const params = new URLSearchParams({
    source: 'telegram',
    source_id: sourceId,
    wait: String(UPLOAD_WAIT_SECONDS),
  });

  const gif = await requestUnigif<UnigifGif>(`/api/v1/gifs?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!gif) return undefined;

  return {
    id: gif.id,
    gif: buildApiVideoFromUnigif(gif),
    isDuplicate: gif.duplicate,
  };
}

function markUnigifGifUsed(gif: ApiVideo & { externalSource: ApiExternalGifSource }) {
  requestUnigif(`/api/v1/gifs/${encodeURIComponent(gif.externalSource.id)}/use`, { method: 'POST' })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[unigif] usage ping failed', err);
    });
}

async function fetchUnigifGifBlob(gif: ApiVideo & { externalSource: ApiExternalGifSource }) {
  const response = await fetch(gif.externalSource.mp4Url);
  if (!response.ok) {
    throw new Error(`UNIGIF media request failed: HTTP ${response.status}`);
  }

  return response.blob();
}

/**
 * Turns a UNIGIF GIF into something Telegram can send: the Telegram copy sent earlier this session,
 * or an upload of the MP4 flagged as a GIF
 */
export async function prepareUnigifGifForSending(
  gif: ApiVideo & { externalSource: ApiExternalGifSource },
): Promise<{ gif: ApiVideo } | { attachment: ApiAttachment }> {
  markUnigifGifUsed(gif);

  const telegramVideo = telegramVideoByUnigifId.get(gif.externalSource.id);
  if (telegramVideo) {
    return { gif: telegramVideo };
  }

  const blob = await fetchUnigifGifBlob(gif);
  const { width, height, duration } = gif;

  return {
    attachment: {
      blob,
      blobUrl: URL.createObjectURL(blob),
      filename: getUnigifFileName(gif.externalSource.id),
      mimeType: 'video/mp4',
      size: blob.size,
      quick: width && height ? { width, height, duration } : undefined,
      isGif: true,
    },
  };
}

function getUnigifFileName(unigifId: string) {
  return `${FILE_NAME_PREFIX}${unigifId}.mp4`;
}

export function rememberTelegramVideoForUnigif(video: ApiVideo) {
  // Local uploads carry a temporary id until Telegram returns the real document
  if (!video.isGif || isUnigifVideo(video) || !TELEGRAM_DOCUMENT_ID_PATTERN.test(video.id)) return;

  const unigifId = video.fileName.match(FILE_NAME_PATTERN)?.[1];
  if (unigifId) {
    telegramVideoByUnigifId.set(unigifId, video);
  }
}

/**
 * Follows the UNIGIF event stream until the returned function is called, reconnecting with a backoff.
 * `fetch` is used over `EventSource` so the stream goes through the same `app://` proxy as other calls.
 */
export function subscribeToUnigifEvents(onEvent: (type: UnigifEventType, id?: string) => void) {
  const controller = new AbortController();
  let retryDelay = EVENTS_RETRY_MIN_MS;

  async function runStream() {
    while (!controller.signal.aborted) {
      try {
        const currentConfig = await loadUnigifConfig();
        if (!currentConfig?.isEnabled) return;

        const url = `${PROXY_PREFIX}/api/v1/events?${TOKEN_QUERY}=${encodeURIComponent(currentConfig.token)}`;
        const response = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`UNIGIF event stream failed: HTTP ${response.status}`);
        }

        retryDelay = EVENTS_RETRY_MIN_MS;
        await readEventStream(response.body, onEvent);
      } catch (err) {
        if (controller.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.warn('[unigif] event stream interrupted', err);
      }

      await pause(retryDelay, controller.signal);
      retryDelay = Math.min(retryDelay * 2, EVENTS_RETRY_MAX_MS);
    }
  }

  void runStream();

  return () => controller.abort();
}

async function requestUnigif<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
  const currentConfig = config?.isEnabled ? config : await loadUnigifConfig();
  if (!currentConfig?.isEnabled) return undefined;

  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, currentConfig.token);
  headers.set('Accept', 'application/json');

  const response = await fetch(`${PROXY_PREFIX}${path}`, { ...init, headers });
  if (!response.ok) {
    const problem: UnigifProblem = await response.json().catch(() => ({}));
    throw new UnigifRequestError(
      problem.detail || problem.title || `UNIGIF request failed: HTTP ${response.status}`,
      response.status,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) as T : undefined;
}

function buildApiVideoFromUnigif(gif: UnigifGif): ApiVideo | undefined {
  const { media } = gif;
  if (gif.status !== READY_STATUS || !media?.mp4) return undefined;

  const mp4Url = buildProxyMediaUrl(media.mp4.url);

  return {
    mediaType: 'video',
    id: `${VIDEO_ID_PREFIX}${gif.id}`,
    mimeType: 'video/mp4',
    duration: (gif.duration_ms || 0) / MS_PER_SECOND,
    fileName: getUnigifFileName(gif.id),
    width: gif.width || media.mp4.width || undefined,
    height: gif.height || media.mp4.height || undefined,
    isGif: true,
    size: media.mp4.bytes,
    externalSource: {
      provider: 'unigif',
      id: gif.id,
      mp4Url,
      previewUrl: media.preview_mp4 ? buildProxyMediaUrl(media.preview_mp4.url) : mp4Url,
      posterUrl: media.poster ? buildProxyMediaUrl(media.poster.url) : undefined,
    },
  };
}

// UNIGIF builds absolute media URLs from its `publicUrl`; the proxy serves the same `/m/...` path
function buildProxyMediaUrl(url: string) {
  const { pathname } = new URL(url, window.location.origin);
  const markerIndex = pathname.lastIndexOf(MEDIA_PATH_MARKER);
  return `${PROXY_PREFIX}${markerIndex === -1 ? pathname : pathname.slice(markerIndex)}`;
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (type: UnigifEventType, id?: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      dispatchEventBlock(block, onEvent);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}

function dispatchEventBlock(block: string, onEvent: (type: UnigifEventType, id?: string) => void) {
  let type = 'message';
  let data = '';
  block.split('\n').forEach((line) => {
    if (line.startsWith('event:')) type = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
  });

  if (!LIVE_EVENT_TYPES.has(type as UnigifEventType)) return;

  let id: string | undefined;
  try {
    id = data ? (JSON.parse(data) as { id?: string }).id : undefined;
  } catch {
    id = undefined;
  }

  onEvent(type as UnigifEventType, id);
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
