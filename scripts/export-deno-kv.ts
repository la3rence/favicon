// @ts-nocheck

const DENO_PREFIX = ["favicon"] as const;
const CLOUDFLARE_PREFIX = "favicon:";
const DEFAULT_OUTPUT_PATH = "migrations/deno-kv-export.json";

type ExportRecord = {
  denoKey: [string, string];
  cloudflareKey: string;
  value: number;
};

function ensureParentDirectory(path: string): Promise<void> {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex <= 0) return Promise.resolve();
  return Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
}

function normalizeOutputPath(path: string): string {
  return path.endsWith(".json") ? path : `${path}.json`;
}
//
function getBulkPath(path: string): string {
  if (path.endsWith(".json")) return path.replace(/\.json$/, ".bulk.json");
  return `${path}.bulk.json`;
}

function printHelp() {
  console.log(`Usage:
  deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts [output.json] [--remote] [--database-id <id>]

Options:
  --remote                 Export from remote Deno KV (Deno Deploy).
  --database-id <id>       Remote Deno KV database id.
  --help                   Show this help message.

Environment variables:
  DENO_KV_DATABASE_ID      Remote database id (used with --remote or by itself).
  DENO_KV_ACCESS_TOKEN     Required for remote export authentication.

Examples:
  # Local Deno KV export
  deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts

  # Remote Deno KV export
  DENO_KV_DATABASE_ID=xxxx DENO_KV_ACCESS_TOKEN=yyyy deno run --allow-read --allow-write --allow-env --allow-net --unstable-kv scripts/export-deno-kv.ts --remote
`);
}

function parseCliArgs(args: string[]) {
  let outputPath = DEFAULT_OUTPUT_PATH;
  let databaseId;
  let useRemote = false;
  let outputPathProvided = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      Deno.exit(0);
    }

    if (arg === "--remote") {
      useRemote = true;
      continue;
    }

    if (arg === "--database-id") {
      databaseId = args[index + 1];
      if (!databaseId || databaseId.startsWith("--")) {
        throw new Error("Missing value for --database-id");
      }
      index++;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (outputPathProvided) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    outputPath = arg;
    outputPathProvided = true;
  }

  return { outputPath, databaseId, useRemote };
}

const { outputPath: outputArg, databaseId: dbIdArg, useRemote } = parseCliArgs(Deno.args);
const outputPath = normalizeOutputPath(outputArg ?? DEFAULT_OUTPUT_PATH);
const bulkPath = getBulkPath(outputPath);

const envDatabaseId = `ebc01b38-2be1-4642-8f2d-90cdfa2dee62`;
const databaseId = envDatabaseId;
const shouldUseRemote = useRemote || Boolean(databaseId);
const connectUrl = databaseId ? `https://api.deno.com/databases/${databaseId}/connect` : undefined;

if (useRemote && !databaseId) {
  throw new Error(
    "Remote export requested but no database id provided. Use --database-id <id> or set DENO_KV_DATABASE_ID.",
  );
}

const kv = shouldUseRemote && connectUrl ? await Deno.openKv(connectUrl) : await Deno.openKv();
const records: ExportRecord[] = [];

for await (const entry of kv.list<bigint>({ prefix: [...DENO_PREFIX] })) {
  const emoji = String(entry.key[1] ?? "");
  const value = Number(entry.value);
  if (!emoji || !Number.isFinite(value)) continue;

  records.push({
    denoKey: ["favicon", emoji],
    cloudflareKey: `${CLOUDFLARE_PREFIX}${emoji}`,
    value,
  });
}

records.sort((a, b) => b.value - a.value);

const totalCount = records.reduce((sum, record) => sum + record.value, 0);
const exportPayload = {
  exportedAt: new Date().toISOString(),
  source: shouldUseRemote ? "deno-kv-remote" : "deno-kv-local",
  prefix: [...DENO_PREFIX],
  databaseId: shouldUseRemote ? databaseId : null,
  totalRecords: records.length,
  totalCount,
  records,
};

const bulkPayload = records.map((record) => ({
  key: record.cloudflareKey,
  value: String(record.value),
  metadata: {
    count: record.value,
  },
}));

await ensureParentDirectory(outputPath);
await ensureParentDirectory(bulkPath);
await Deno.writeTextFile(outputPath, JSON.stringify(exportPayload, null, 2));
await Deno.writeTextFile(bulkPath, JSON.stringify(bulkPayload, null, 2));

console.log(`Exported ${records.length} keys (${totalCount} total hits)`);
console.log(`Mode: ${shouldUseRemote ? "remote" : "local"}`);
if (shouldUseRemote && databaseId) {
  console.log(`Database: ${databaseId}`);
}
console.log(`Detailed export: ${outputPath}`);
console.log(`Cloudflare KV bulk file: ${bulkPath}`);
