import emojiRegex from "emoji-regex";
import emojiFromText from "emoji-from-text";
import { UAParser } from "ua-parser-js";

import { makeHomePage } from "./homePage";
import { incrementCount, type CloudflareEnv, type PerfLogContext } from "./db";

const ONE_DAY = 60 * 60 * 24;
const ONE_WEEK = ONE_DAY * 7;
const TWEMOJI_BASE_URL = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function logPerf(enabled: boolean, payload: Record<string, unknown>) {
  if (!enabled) return;
  console.log(
    JSON.stringify({
      type: "perf",
      scope: "request",
      ...payload,
    }),
  );
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
  const maybeEmoji = (textMatch as { match?: { emoji?: { char?: string } } })?.match?.emoji?.char;
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

async function makePngResponse(emoji: string, perf: PerfLogContext = {}): Promise<Response | null> {
  const startedAt = Date.now();
  const codePoint = toTwemojiCodePoint(emoji);
  if (!codePoint) return null;

  const fetchStartedAt = Date.now();
  const twemojiResponse = await fetch(`${TWEMOJI_BASE_URL}/${codePoint}.png`);
  const fetchMs = Date.now() - fetchStartedAt;
  logPerf(Boolean(perf.enabled), {
    stage: "twemoji_fetch",
    requestId: perf.requestId ?? null,
    codePoint,
    status: twemojiResponse.status,
    fetchMs,
  });
  if (!twemojiResponse.ok) return null;

  const response = new Response(twemojiResponse.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_WEEK}`,
    },
  });

  logPerf(Boolean(perf.enabled), {
    stage: "png_response_ready",
    requestId: perf.requestId ?? null,
    totalMs: Date.now() - startedAt,
  });
  return response;
}

export default {
  async fetch(
    request: Request,
    env: CloudflareEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const perfEnabled = url.searchParams.get("perf") === "1" || env.DEBUG_PERF === "1";
    const perf: PerfLogContext = {
      enabled: perfEnabled,
      requestId: request.headers.get("cf-ray") ?? undefined,
    };
    const requestStartedAt = Date.now();
    let response: Response;

    logPerf(perfEnabled, {
      stage: "request_start",
      requestId: perf.requestId ?? null,
      path: url.pathname,
      method: request.method,
      userAgent: request.headers.get("user-agent") ?? null,
    });

    if (url.pathname === "/") {
      const homeStartedAt = Date.now();
      const html = await makeHomePage(env, perf);
      logPerf(perfEnabled, {
        stage: "home_render",
        requestId: perf.requestId ?? null,
        renderMs: Date.now() - homeStartedAt,
      });

      response = new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_DAY}`,
        },
      });
      logPerf(perfEnabled, {
        stage: "request_summary",
        requestId: perf.requestId ?? null,
        path: url.pathname,
        status: response.status,
        totalMs: Date.now() - requestStartedAt,
      });
      return response;
    }

    const emoji = getEmojiFromPathname(url.pathname);
    ctx.waitUntil(incrementCount(env, emoji, perf));
    logPerf(perfEnabled, {
      stage: "increment_scheduled",
      requestId: perf.requestId ?? null,
      emoji,
    });

    // ?svg tacked on the end forces SVG, handy for CSS cursors.
    const forceSvg = url.searchParams.has("svg");
    if (!forceSvg && isLegacySafari(request.headers.get("user-agent") ?? "")) {
      const png = await makePngResponse(emoji, perf);
      if (png) {
        response = png;
        logPerf(perfEnabled, {
          stage: "request_summary",
          requestId: perf.requestId ?? null,
          path: url.pathname,
          responseType: "png",
          status: response.status,
          totalMs: Date.now() - requestStartedAt,
        });
        return response;
      }
      // Fallback to SVG if PNG fetch fails.
      response = makeSvgResponse(emoji);
      logPerf(perfEnabled, {
        stage: "request_summary",
        requestId: perf.requestId ?? null,
        path: url.pathname,
        responseType: "svg_fallback",
        status: response.status,
        totalMs: Date.now() - requestStartedAt,
      });
      return response;
    }

    response = makeSvgResponse(emoji);
    logPerf(perfEnabled, {
      stage: "request_summary",
      requestId: perf.requestId ?? null,
      path: url.pathname,
      responseType: "svg",
      status: response.status,
      totalMs: Date.now() - requestStartedAt,
    });
    return response;
  },
};
