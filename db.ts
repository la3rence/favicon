const EMOJI_KEY_PREFIX = "favicon:";
const COUNTRY_KEY_PREFIX = "country:";
const REFERRER_KEY_PREFIX = "referrer:";
const GEO_KEY_PREFIX = "geo:";

interface StatMetadata {
  count?: number;
}

interface AnalyticsDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

interface AnalyticsEngineDataset {
  writeDataPoint(data: AnalyticsDataPoint): void;
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
  ANALYTICS?: AnalyticsEngineDataset;
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

function getKey(prefix: string, value: string): string {
  return `${prefix}${value}`;
}

async function incrementCounter(env: CloudflareEnv, key: string) {
  const currentData = await env.FAVICON_STATS.getWithMetadata(key);
  const current = Number(currentData.metadata?.count ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.FAVICON_STATS.put(key, String(next), {
    metadata: { count: next },
  });
}

export async function incrementCount(
  env: CloudflareEnv,
  emoji: string,
  perf: PerfLogContext = {},
): Promise<void> {
  const startedAt = Date.now();
  const key = getKey(EMOJI_KEY_PREFIX, emoji);
  const updateStartedAt = Date.now();
  await incrementCounter(env, key);
  const updateMs = Date.now() - updateStartedAt;

  logPerf(perf.enabled, {
    stage: "increment",
    requestId: perf.requestId ?? null,
    key,
    updateMs,
    totalMs: Date.now() - startedAt,
  });
}

export async function incrementSourceCounts(
  env: CloudflareEnv,
  country: string,
  referrerHost: string,
  geoBucket: string,
  perf: PerfLogContext = {},
): Promise<void> {
  const startedAt = Date.now();
  const countryKey = getKey(COUNTRY_KEY_PREFIX, country);
  const referrerKey = getKey(REFERRER_KEY_PREFIX, referrerHost);
  const geoKey = getKey(GEO_KEY_PREFIX, geoBucket);
  const updateStartedAt = Date.now();
  await Promise.all([
    incrementCounter(env, countryKey),
    incrementCounter(env, referrerKey),
    incrementCounter(env, geoKey),
  ]);
  const updateMs = Date.now() - updateStartedAt;

  logPerf(perf.enabled, {
    stage: "increment_sources",
    requestId: perf.requestId ?? null,
    countryKey,
    referrerKey,
    geoKey,
    updateMs,
    totalMs: Date.now() - startedAt,
  });
}

async function getTopCountsByPrefix(
  env: CloudflareEnv,
  prefix: string,
  perf: PerfLogContext,
  label: string,
): Promise<Array<[string, number]>> {
  const startedAt = Date.now();
  const values: Array<[string, number]> = [];
  let cursor: string | undefined;
  let complete = false;
  let pages = 0;

  while (!complete) {
    pages++;
    const page = await env.FAVICON_STATS.list({ prefix, cursor });
    cursor = page.cursor;
    complete = page.list_complete;
    for (const entry of page.keys) {
      const count = Number(entry.metadata?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) continue;
      values.push([entry.name.replace(prefix, ""), count]);
    }
  }

  values.sort((a, b) => b[1] - a[1]);
  const top = values.slice(0, 12);
  logPerf(perf.enabled, {
    stage: "source_summary",
    requestId: perf.requestId ?? null,
    label,
    pages,
    totalRows: values.length,
    totalMs: Date.now() - startedAt,
  });
  return top;
}

export async function getTopRequestSources(env: CloudflareEnv, perf: PerfLogContext = {}) {
  const [topCountries, topReferrers, topGeoBuckets] = await Promise.all([
    getTopCountsByPrefix(env, COUNTRY_KEY_PREFIX, perf, "countries"),
    getTopCountsByPrefix(env, REFERRER_KEY_PREFIX, perf, "referrers"),
    getTopCountsByPrefix(env, GEO_KEY_PREFIX, perf, "geo_buckets"),
  ]);
  return { topCountries, topReferrers, topGeoBuckets };
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
    const page = await env.FAVICON_STATS.list({ prefix: EMOJI_KEY_PREFIX, cursor });
    const listMs = Date.now() - listStartedAt;
    cursor = page.cursor;
    complete = page.list_complete;
    keysScanned += page.keys.length;
    const valuesReadStartedAt = Date.now();

    for (const entry of page.keys) {
      const count = Number(entry.metadata?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) continue;
      metadataHits++;
      const emoji = entry.name.replace(EMOJI_KEY_PREFIX, "");
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
