const KEY_PREFIX = "favicon:";

interface StatMetadata {
  count?: number;
}

interface KVListResult {
  keys: Array<{ name: string; metadata?: StatMetadata | null }>;
  list_complete: boolean;
  cursor?: string;
}

interface StatsKVNamespace {
  getWithMetadata(key: string): Promise<{ value: string | null; metadata: StatMetadata | null }>;
  put(key: string, value: string, options?: { metadata?: StatMetadata }): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<KVListResult>;
}

export interface CloudflareEnv {
  FAVICON_STATS: StatsKVNamespace;
  DEBUG_PERF?: string;
}

export interface PerfLogContext {
  enabled?: boolean;
  requestId?: string;
}

function logPerf(enabled: boolean | undefined, payload: Record<string, unknown>) {
  if (!enabled) return;
  console.log(
    JSON.stringify({
      type: "perf",
      scope: "db",
      ...payload,
    }),
  );
}

function getKeyForEmoji(emoji: string): string {
  return `${KEY_PREFIX}${emoji}`;
}

export async function incrementCount(
  env: CloudflareEnv,
  emoji: string,
  perf: PerfLogContext = {},
): Promise<void> {
  const startedAt = Date.now();
  const key = getKeyForEmoji(emoji);
  const getStartedAt = Date.now();
  const currentData = await env.FAVICON_STATS.getWithMetadata(key);
  const getMs = Date.now() - getStartedAt;
  const current = Number(currentData.metadata?.count ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  const putStartedAt = Date.now();
  await env.FAVICON_STATS.put(key, String(next), {
    metadata: { count: next },
  });
  const putMs = Date.now() - putStartedAt;

  logPerf(perf.enabled, {
    stage: "increment",
    requestId: perf.requestId ?? null,
    key,
    getMs,
    putMs,
    totalMs: Date.now() - startedAt,
  });
}

export async function getEmojiCounts(env: CloudflareEnv, perf: PerfLogContext = {}) {
  const startedAt = Date.now();
  const emojis: Array<[string, number]> = [];
  let cursor: string | undefined;
  let complete = false;
  let pageNumber = 0;
  let keysScanned = 0;
  let metadataHits = 0;

  while (!complete) {
    pageNumber++;
    const listStartedAt = Date.now();
    const page = await env.FAVICON_STATS.list({ prefix: KEY_PREFIX, cursor });
    const listMs = Date.now() - listStartedAt;
    cursor = page.cursor;
    complete = page.list_complete;
    keysScanned += page.keys.length;
    const valuesReadStartedAt = Date.now();

    for (const entry of page.keys) {
      const count = Number(entry.metadata?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) continue;
      metadataHits++;
      const emoji = entry.name.replace(KEY_PREFIX, "");
      emojis.push([emoji, count]);
    }

    logPerf(perf.enabled, {
      stage: "kv_page",
      requestId: perf.requestId ?? null,
      page: pageNumber,
      keysInPage: page.keys.length,
      listMs,
      valuesReadMs: Date.now() - valuesReadStartedAt,
      metadataHits,
      cursor: page.cursor ?? null,
      listComplete: page.list_complete,
    });
  }

  emojis.sort((a, b) => b[1] - a[1]);

  const totalCount = emojis.reduce((acc, [, count]) => acc + count, 0);
  // Filter out country flags
  const [topEmojis, countryEmojis] = emojis.reduce<
    [Array<[string, number]>, Array<[string, number]>]
  >(
    (acc, [emoji, count]) => {
      if (emoji.match(/[🇦-🇿]{2}/u)) {
        acc[1].push([emoji, count]);
      } else {
        acc[0].push([emoji, count]);
      }
      return acc;
    },
    [[], []],
  );

  logPerf(perf.enabled, {
    stage: "kv_summary",
    requestId: perf.requestId ?? null,
    pages: pageNumber,
    keysScanned,
    emojisCounted: emojis.length,
    metadataHits,
    totalCount,
    totalMs: Date.now() - startedAt,
  });

  return { topEmojis, countryEmojis, totalCount };
}
