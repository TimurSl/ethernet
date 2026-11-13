import type { ApiVideo } from '../../../api/types';
import type { UnigifEventType } from '../../../api/unigif';
import type { ActionReturnType, GlobalState } from '../../types';
import { ApiMediaFormat } from '../../../api/types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { getEthernetString } from '../../../util/ethernetLang';
import * as mediaLoader from '../../../util/mediaLoader';
import {
  addUnigifGif,
  checkIsUnigifEnabled,
  fetchUnigifGif,
  fetchUnigifGifs,
  isUnigifVideo,
  subscribeToUnigifEvents,
  UnigifRequestError,
  updateUnigifConfigCache,
} from '../../../api/unigif';
import { getVideoMediaHash } from '../../helpers';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../../index';

const NOT_FOUND_STATUS = 404;

let unsubscribeFromEvents: NoneToVoidFunction | undefined;

addActionHandler('loadUnigifGifs', async (global, actions, payload): Promise<void> => {
  const isEnabled = await checkIsUnigifEnabled();
  global = getGlobal();

  if (!isEnabled) {
    stopUnigifEvents();
    global = updateUnigif(global, { isEnabled: false, gifs: undefined, nextCursor: undefined });
    setGlobal(global);
    return;
  }

  // The event stream keeps a loaded list current, so reopening the GIF panel does not refetch it
  if (!payload?.force && unsubscribeFromEvents && global.gifs.unigif.gifs) return;

  startUnigifEvents();

  global = updateUnigif(global, { isEnabled: true });
  setGlobal(global);

  try {
    const result = await fetchUnigifGifs({});
    if (!result) return;

    global = getGlobal();
    global = updateUnigif(global, { gifs: result.gifs, nextCursor: result.nextCursor });
    setGlobal(global);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[unigif] could not load the library', err);

    global = getGlobal();
    if (!global.gifs.unigif.gifs) {
      global = updateUnigif(global, { gifs: [] });
      setGlobal(global);
    }
  }
});

addActionHandler('loadMoreUnigifGifs', async (global): Promise<void> => {
  const { nextCursor, isLoadingMore, isEnabled } = global.gifs.unigif;
  if (!isEnabled || !nextCursor || isLoadingMore) return;

  global = updateUnigif(global, { isLoadingMore: true });
  setGlobal(global);

  try {
    const result = await fetchUnigifGifs({ cursor: nextCursor });
    global = getGlobal();
    if (!result || global.gifs.unigif.nextCursor !== nextCursor) return;

    global = updateUnigif(global, {
      gifs: mergeGifs(global.gifs.unigif.gifs || [], result.gifs),
      nextCursor: result.nextCursor,
    });
    setGlobal(global);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[unigif] could not load more GIFs', err);
  } finally {
    global = getGlobal();
    global = updateUnigif(global, { isLoadingMore: undefined });
    setGlobal(global);
  }
});

addActionHandler('saveGifToUnigif', async (global, actions, payload): Promise<void> => {
  const { gif, tabId = getCurrentTabId() } = payload;
  if (isUnigifVideo(gif)) {
    actions.showNotification({ message: getEthernetString(undefined, 'EthernetUnigifAlreadyAdded'), tabId });
    return;
  }

  try {
    const blobUrl = await mediaLoader.fetch(getVideoMediaHash(gif, 'full')!, ApiMediaFormat.BlobUrl);
    const blob = await (await fetch(blobUrl)).blob();
    const result = await addUnigifGif(blob, gif.id);
    if (!result) return;

    if (result.gif) {
      global = getGlobal();
      global = prependUnigifGif(global, result.gif);
      setGlobal(global);
    }

    actions.showNotification({
      title: getEthernetString(undefined, result.isDuplicate ? 'EthernetUnigifAlreadyAdded' : 'EthernetUnigifAdded'),
      message: getEthernetString(undefined, result.gif ? 'EthernetUnigifAddedUnsorted' : 'EthernetUnigifProcessing'),
      icon: 'gifs',
      tabId,
    });
  } catch (err) {
    actions.showNotification({
      title: getEthernetString(undefined, 'EthernetUnigifAddFailed'),
      message: err instanceof Error ? err.message : String(err),
      tabId,
    });
  }
});

addActionHandler('applyUnigifConfig', (global, actions, payload): ActionReturnType => {
  const { config } = payload;
  updateUnigifConfigCache(config);
  stopUnigifEvents();

  global = updateUnigif(global, {
    isEnabled: config.isEnabled,
    gifs: undefined,
    nextCursor: undefined,
  });
  setGlobal(global);

  if (config.isEnabled) {
    actions.loadUnigifGifs({ force: true });
  } else {
    actions.loadSavedGifs();
  }
});

function startUnigifEvents() {
  if (unsubscribeFromEvents) return;
  unsubscribeFromEvents = subscribeToUnigifEvents(handleUnigifEvent);
}

function stopUnigifEvents() {
  unsubscribeFromEvents?.();
  unsubscribeFromEvents = undefined;
}

async function handleUnigifEvent(type: UnigifEventType, unigifId?: string) {
  if (type === 'resync') {
    getActions().loadUnigifGifs({ force: true });
    return;
  }

  // `gif.added` arrives before processing ends; the GIF is listed once `gif.ready` follows
  if (!unigifId || type === 'gif.added') return;

  let global = getGlobal();
  if (type === 'gif.deleted') {
    global = removeUnigifGif(global, unigifId);
    setGlobal(global);
    return;
  }

  try {
    const gif = await fetchUnigifGif(unigifId);
    if (!gif) return;

    global = getGlobal();
    global = type === 'gif.ready' ? prependUnigifGif(global, gif) : replaceUnigifGif(global, gif);
    setGlobal(global);
  } catch (err) {
    // A GIF the key cannot see (hidden hashtags) answers 404
    if (err instanceof UnigifRequestError && err.status === NOT_FOUND_STATUS) {
      global = getGlobal();
      global = removeUnigifGif(global, unigifId);
      setGlobal(global);
    }
  }
}

function updateUnigif<T extends GlobalState>(global: T, update: Partial<GlobalState['gifs']['unigif']>): T {
  return {
    ...global,
    gifs: {
      ...global.gifs,
      unigif: {
        ...global.gifs.unigif,
        ...update,
      },
    },
  };
}

function prependUnigifGif<T extends GlobalState>(global: T, gif: ApiVideo): T {
  const { gifs } = global.gifs.unigif;
  if (!gifs) return global;

  return updateUnigif(global, { gifs: [gif, ...gifs.filter(({ id }) => id !== gif.id)] });
}

function replaceUnigifGif<T extends GlobalState>(global: T, gif: ApiVideo): T {
  const { gifs } = global.gifs.unigif;
  if (!gifs?.some(({ id }) => id === gif.id)) return prependUnigifGif(global, gif);

  return updateUnigif(global, { gifs: gifs.map((current) => (current.id === gif.id ? gif : current)) });
}

function removeUnigifGif<T extends GlobalState>(global: T, unigifId: string): T {
  const { gifs } = global.gifs.unigif;
  if (!gifs) return global;

  return updateUnigif(global, { gifs: gifs.filter((gif) => gif.externalSource?.id !== unigifId) });
}

function mergeGifs(current: ApiVideo[], next: ApiVideo[]) {
  const knownIds = new Set(current.map(({ id }) => id));
  return [...current, ...next.filter(({ id }) => !knownIds.has(id))];
}
