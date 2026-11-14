import { useEffect, useRef, useState } from '../../../../lib/teact/teact';
import { getGlobal } from '../../../../global';

import type { ApiVideo } from '../../../../api/types';

import { throttle } from '../../../../util/schedulers';
import { callApi } from '../../../../api/gramjs';
import { fetchUnigifGifs } from '../../../../api/unigif';

import useLastCallback from '../../../../hooks/useLastCallback';

type GifSearchResults = {
  key: string;
  gifs: ApiVideo[];
  nextOffset?: string;
};

const SEARCH_THROTTLE = 500;

export default function useGifSearch({ query, isUnigif }: { query?: string; isUnigif?: boolean }) {
  const [results, setResults] = useState<GifSearchResults | undefined>();

  const searchIntentRef = useRef<string | undefined>();
  const loadingMoreKeyRef = useRef<string | undefined>();
  const runThrottledSearchRef = useRef<(cb: NoneToVoidFunction) => void>();
  runThrottledSearchRef.current ??= throttle((cb: NoneToVoidFunction) => cb(), SEARCH_THROTTLE, false);

  useEffect(() => {
    setResults(undefined);

    if (!query) {
      searchIntentRef.current = undefined;
      return;
    }

    searchIntentRef.current = query;

    runThrottledSearchRef.current!(async () => {
      if (searchIntentRef.current !== query) {
        return;
      }

      const result = await searchGifs(query, isUnigif);

      if (!result || searchIntentRef.current !== query) {
        return;
      }

      setResults({
        key: query,
        gifs: result.gifs,
        nextOffset: result.nextOffset,
      });
    });
  }, [query, isUnigif]);

  const searchMore = useLastCallback(() => {
    const currentResults = results;
    if (
      !currentResults || currentResults.key !== searchIntentRef.current
      || !currentResults.nextOffset || loadingMoreKeyRef.current === currentResults.key
    ) {
      return;
    }

    loadingMoreKeyRef.current = currentResults.key;

    void (async () => {
      try {
        const result = await searchGifs(currentResults.key, isUnigif, currentResults.nextOffset);
        if (!result) {
          return;
        }

        setResults((prev) => {
          if (!prev || prev.key !== currentResults.key) {
            return prev;
          }

          const currentIds = new Set(prev.gifs.map(({ id }) => id));

          return {
            ...prev,
            gifs: [...prev.gifs, ...result.gifs.filter(({ id }) => !currentIds.has(id))],
            nextOffset: result.nextOffset,
          };
        });
      } finally {
        if (loadingMoreKeyRef.current === currentResults.key) {
          loadingMoreKeyRef.current = undefined;
        }
      }
    })();
  });

  return { results, searchMore };
}

async function searchGifs(
  query: string, isUnigif?: boolean, offset?: string,
): Promise<{ gifs: ApiVideo[]; nextOffset?: string } | undefined> {
  if (!isUnigif) {
    return callApi('searchGifs', {
      query,
      offset,
      username: getGlobal().config?.gifSearchUsername,
    });
  }

  // UNIGIF matches hashtags: `cat funny` needs both, `-dog` excludes one
  try {
    const result = await fetchUnigifGifs({ query, cursor: offset });
    return result && { gifs: result.gifs, nextOffset: result.nextCursor };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[unigif] search failed', err);
    return { gifs: [] };
  }
}
