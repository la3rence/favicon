const KEY_PREFIX = "favicon:";

interface KVListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

interface StatsKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
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
  const currentRaw = await env.FAVICON_STATS.get(key);
  const getMs = Date.now() - getStartedAt;
  const current = Number.parseInt(currentRaw ?? "0", 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  const putStartedAt = Date.now();
  await env.FAVICON_STATS.put(key, String(next));
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

  while (!complete) {
    pageNumber++;
    const listStartedAt = Date.now();
    const page = await env.FAVICON_STATS.list({ prefix: KEY_PREFIX, cursor });
    const listMs = Date.now() - listStartedAt;
    cursor = page.cursor;
    complete = page.list_complete;
    keysScanned += page.keys.length;

    const getStartedAt = Date.now();

    for (const entry of page.keys) {
      const emoji = entry.name.replace(KEY_PREFIX, "");
      const value = await env.FAVICON_STATS.get(entry.name);
      const count = Number.parseInt(value ?? "0", 10);
      if (!Number.isFinite(count) || count <= 0) continue;
      emojis.push([emoji, count]);
    }

    logPerf(perf.enabled, {
      stage: "kv_page",
      requestId: perf.requestId ?? null,
      page: pageNumber,
      keysInPage: page.keys.length,
      listMs,
      getValuesMs: Date.now() - getStartedAt,
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
    totalCount,
    totalMs: Date.now() - startedAt,
  });

  return { topEmojis, countryEmojis, totalCount };
}
