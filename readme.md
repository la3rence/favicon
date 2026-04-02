# Fav.Farm

A little website that serves up favicon emojis.

It works by wrapping an emoji in SVG text like so:

```svg
<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 16 16'><text x='0' y='14'>😽</text></svg>
```

Handy.

Works like this:

```html
<link rel="icon" href="https://fav.farm/💩" />
<link rel="icon" href="https://fav.farm/🌶" />
<link rel="icon" href="https://fav.farm/🔥" />
<link rel="icon" href="https://fav.farm/🥰" />
<link rel="icon" href="https://fav.farm/🖥" />
<link rel="icon" href="https://fav.farm/👓" />
```

Also works with CSS:

```css
a {
  cursor:
    url("https://fav.farm/🖕") 15 0,
    auto;
}
```

## Local development (Cloudflare + Vite)

This project now runs locally with Cloudflare Workers + Vite via `@cloudflare/vite-plugin`.

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite.

### Local KV stats

Stats are stored in Cloudflare KV with keys shaped like:

```txt
favicon:<emoji>
```

`incrementCount` currently uses KV read/modify/write (simple mode), so extremely high concurrency can lose increments.

## Deno KV export migration script [delete after migration ]

To export historical stats from local Deno KV:

```bash
npm run migrate:export-deno-kv
```

Optional custom output path:

```bash
deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts migrations/my-export.json
```

Export directly from remote Deno KV (Deno Deploy) :

```bash
DENO_KV_DATABASE_ID=<your_database_id> \
DENO_KV_ACCESS_TOKEN=<your_access_token> \
deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts --remote
```

Remote export with custom output path:

```bash
DENO_KV_DATABASE_ID=<your_database_id> \
DENO_KV_ACCESS_TOKEN=<your_access_token> \
deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts migrations/remote-export.json --remote
```

The script writes:

- `migrations/deno-kv-export.json` (detailed export)
- `migrations/deno-kv-export.bulk.json` (Cloudflare KV bulk-friendly key/value format)
  asdfasdd
