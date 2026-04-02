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
}

function getKeyForEmoji(emoji: string): string {
  return `${KEY_PREFIX}${emoji}`;
}

export async function incrementCount(env: CloudflareEnv, emoji: string): Promise<void> {
  const key = getKeyForEmoji(emoji);
  const currentRaw = await env.FAVICON_STATS.get(key);
  const current = Number.parseInt(currentRaw ?? "0", 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.FAVICON_STATS.put(key, String(next));
}

export async function getEmojiCounts(env: CloudflareEnv) {
  const emojis: Array<[string, number]> = [];
  let cursor: string | undefined;
  let complete = false;

  while (!complete) {
    const page = await env.FAVICON_STATS.list({ prefix: KEY_PREFIX, cursor });
    cursor = page.cursor;
    complete = page.list_complete;

    for (const entry of page.keys) {
      const emoji = entry.name.replace(KEY_PREFIX, "");
      const value = await env.FAVICON_STATS.get(entry.name);
      const count = Number.parseInt(value ?? "0", 10);
      if (!Number.isFinite(count) || count <= 0) continue;
      emojis.push([emoji, count]);
    }
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

  return { topEmojis, countryEmojis, totalCount };
}
