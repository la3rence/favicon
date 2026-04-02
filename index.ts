import emojiRegex from "emoji-regex";
import emojiFromText from "emoji-from-text";
import { UAParser } from "ua-parser-js";

import { makeHomePage } from "./homePage";
import { incrementCount, type CloudflareEnv } from "./db";

const ONE_DAY = 60 * 60 * 24;
const ONE_WEEK = ONE_DAY * 7;
const TWEMOJI_BASE_URL =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const aliases = new Map<string, string>([
  ["favicon.ico", "🚜"],
  ["wesbos", "🔥"],
]);

function getEmojiFromPathname(pathname: string): string {
  const maybeEmojiPath = (() => {
    try {
      return decodeURIComponent(pathname.replace("/", ""));
    } catch {
      return pathname.replace("/", "");
    }
  })();
  const alias = aliases.get(maybeEmojiPath);
  if (alias) return alias;
  const emojis = maybeEmojiPath.match(emojiRegex());
  // If there are multiple emojis, just use the first one
  if (emojis?.length) {
    return emojis[0];
  }
  // If there is a word, try to find an emoji in it
  const textMatch = emojiFromText(maybeEmojiPath, true);
  const maybeEmoji = (textMatch as { match?: { emoji?: { char?: string } } })?.match
    ?.emoji?.char;
  if (maybeEmoji) {
    return maybeEmoji;
  }
  // If there are no emojis, return a tractor
  return "🚜";
}

function isLegacySafari(userAgent: string): boolean {
  const ua = UAParser(userAgent);
  const version = Number.parseInt(ua.browser.version ?? "", 10);
  return ua.browser.name === "Safari" && Number.isFinite(version) && version < 26;
}

function toTwemojiCodePoint(emoji: string): string {
  return Array.from(emoji)
    .map((symbol) => symbol.codePointAt(0))
    .filter((codePoint): codePoint is number => codePoint !== undefined && codePoint !== 0xfe0f)
    .map((codePoint) => codePoint.toString(16))
    .join("-");
}

function makeSvgResponse(emoji: string): Response {
  return new Response(
    `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 16 16'><text x='0' y='14'>${emoji}</text></svg>`,
    {
      status: 200,
      headers: {
        "content-type": "image/svg+xml;",
        "cache-control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_WEEK}`,
      },
    },
  );
}

async function makePngResponse(emoji: string): Promise<Response | null> {
  const codePoint = toTwemojiCodePoint(emoji);
  if (!codePoint) return null;

  const twemojiResponse = await fetch(`${TWEMOJI_BASE_URL}/${codePoint}.png`);
  if (!twemojiResponse.ok) return null;

  return new Response(twemojiResponse.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_WEEK}`,
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: CloudflareEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(await makeHomePage(env), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_DAY}`,
        },
      });
    }

    const emoji = getEmojiFromPathname(url.pathname);
    ctx.waitUntil(incrementCount(env, emoji));

    // ?svg tacked on the end forces SVG, handy for CSS cursors.
    const forceSvg = url.searchParams.has("svg");
    if (!forceSvg && isLegacySafari(request.headers.get("user-agent") ?? "")) {
      const png = await makePngResponse(emoji);
      if (png) return png;
      // Fallback to SVG if PNG fetch fails.
      return makeSvgResponse(emoji);
    }

    return makeSvgResponse(emoji);
  }
};
