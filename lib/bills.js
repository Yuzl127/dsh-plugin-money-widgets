/**
 * Host-side bill ledger built from the session transcript logs themselves.
 *
 * The client-side projection hints only describe sessions the Host has loaded,
 * so a panel in the sidebar cannot see history through them. Every session's
 * log is on disk (`<DSH_HOME>/sessions/<slug>/session-<id>/session.v4.jsonl.zstd`),
 * so this module reads those logs directly, folds the `assistant/message`
 * usage records with the same price table the live projection uses, and
 * answers one JSON document the panel can render.
 *
 * The log is a concatenation of independent zstd frames (one per append), so a
 * single `zstdDecompressSync` call only returns the first frame; the frames are
 * located by their magic number and decompressed one by one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const CACHE_MS = 15_000;
const MAX_ROWS = 400;

/** Decompress every concatenated zstd frame in `buffer`, in order. */
export function decodeZstdFrames(buffer) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (
      buffer[index] === ZSTD_MAGIC[0] &&
      buffer[index + 1] === ZSTD_MAGIC[1] &&
      buffer[index + 2] === ZSTD_MAGIC[2] &&
      buffer[index + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(index);
    }
  }
  if (offsets.length === 0) return "";
  const chunks = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"));
    } catch {
      // A truncated tail frame is normal while a session is being written.
    }
  }
  return chunks.join("");
}

/** Beijing wall clock (UTC+8, no DST) hour for an epoch millisecond value. */
function beijingParts(ms) {
  const shifted = new Date(ms + 8 * 3600 * 1000);
  return {
    day: shifted.getUTCDay(),
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
  };
}

/** Beijing calendar day key (`YYYY-MM-DD`) for an epoch millisecond value. */
export function beijingDayKey(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** True during the documented peak window: Mon–Fri 09:00–12:00, 14:00–18:00. */
export function isPeakTime(ms) {
  const { day, hour } = beijingParts(ms);
  if (day === 0 || day === 6) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

function emptyBucket() {
  return { input: 0, cacheRead: 0, output: 0, cost: 0, messages: 0 };
}

function addToBucket(bucket, usage, cost) {
  bucket.input += usage.inputTokens ?? 0;
  bucket.cacheRead += usage.cacheReadTokens ?? 0;
  bucket.output += usage.outputTokens ?? 0;
  bucket.cost += cost;
  bucket.messages += 1;
}

/** Add one already-folded bucket into another. */
function mergeBucket(target, source) {
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.output += source.output;
  target.cost += source.cost;
  target.messages += source.messages;
}

/** Cost in CNY for one usage record, honouring the peak/off-peak factor. */
export function computeCost(usage, prices, peak) {
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const raw =
    (input / 1e6) * prices.cacheMiss +
    (cacheRead / 1e6) * prices.cacheHit +
    (output / 1e6) * prices.output;
  return raw * (peak ? 1 : 0.5);
}

/** Price row for a model, guessing by family name when the exact id is absent. */
export function priceOf(model, prices) {
  if (model === undefined) return undefined;
  if (prices[model] !== undefined) return prices[model];
  if (/flash/i.test(model)) {
    return (
      prices["deepseek-flash"] ??
      prices["deepseek-v4-flash"] ??
      { cacheHit: 0.04, cacheMiss: 2, output: 8 }
    );
  }
  if (/vision/i.test(model)) {
    return prices["deepseek-v4-flash-vision-exp"] ?? { cacheHit: 0.04, cacheMiss: 2, output: 8 };
  }
  if (/v4|pro/i.test(model)) {
    return prices["deepseek-v4-pro"] ?? { cacheHit: 0.3, cacheMiss: 9, output: 27 };
  }
  return undefined;
}

/**
 * Fold one session log into a bill row.
 * @param filePath - absolute path to `session.v4.jsonl.zstd`.
 * @param prices - peak-hour price table keyed by model id.
 * @param fallbackId - session id to use when the header line is unreadable.
 */
export function readSessionBill(filePath, prices, fallbackId) {
  const text = decodeZstdFrames(readFileSync(filePath));
  if (text.length === 0) return null;
  const totals = emptyBucket();
  const models = Object.create(null);
  const providers = Object.create(null);
  const days = Object.create(null);
  let sessionId = fallbackId;
  let title;
  let updatedAt = 0;
  let turns = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.time === "number" && event.time > updatedAt) updatedAt = event.time;
    if (event.type === "session") {
      if (typeof event.id === "string") sessionId = event.id;
      continue;
    }
    if (event.type === "session/title") {
      const value = event.data?.title;
      if (typeof value === "string" && value.length > 0) title = value;
      continue;
    }
    if (event.type === "turn/start") {
      turns += 1;
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (!usage) continue;
    const source = event.data?.message?.source;
    const model = typeof source?.model === "string" ? source.model : undefined;
    const provider = typeof source?.provider === "string" ? source.provider : undefined;
    const price = priceOf(model, prices);
    const cost = price ? computeCost(usage, price, isPeakTime(event.time ?? Date.now())) : 0;
    addToBucket(totals, usage, cost);
    const modelKey = model ?? "(unknown)";
    if (models[modelKey] === undefined) models[modelKey] = emptyBucket();
    addToBucket(models[modelKey], usage, cost);
    const providerKey = provider ?? "(unknown)";
    if (providers[providerKey] === undefined) providers[providerKey] = emptyBucket();
    addToBucket(providers[providerKey], usage, cost);
    const dayKey = beijingDayKey(typeof event.time === "number" ? event.time : Date.now());
    if (days[dayKey] === undefined) {
      days[dayKey] = { totals: emptyBucket(), models: Object.create(null), providers: Object.create(null) };
    }
    const day = days[dayKey];
    addToBucket(day.totals, usage, cost);
    if (day.models[modelKey] === undefined) day.models[modelKey] = emptyBucket();
    addToBucket(day.models[modelKey], usage, cost);
    if (day.providers[providerKey] === undefined) day.providers[providerKey] = emptyBucket();
    addToBucket(day.providers[providerKey], usage, cost);
  }
  if (totals.messages === 0) return null;
  return {
    sessionId,
    title: title ?? null,
    updatedAt: updatedAt === 0 ? null : updatedAt,
    turns,
    totals,
    models,
    providers,
    days,
  };
}

/** Every `session.v4.jsonl.zstd` below `<sessionsRoot>/<slug>/session-<id>/`. */
export function listSessionLogs(sessionsRoot) {
  const found = [];
  let slugs;
  try {
    slugs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let dirs;
    try {
      dirs = readdirSync(join(sessionsRoot, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !dir.name.startsWith("session-")) continue;
      const file = join(sessionsRoot, slug.name, dir.name, "session.v4.jsonl.zstd");
      try {
        const stats = statSync(file);
        found.push({ file, sessionId: dir.name, mtime: stats.mtimeMs, size: stats.size });
      } catch {
        // A session directory without a log is normal (never flushed yet).
      }
    }
  }
  return found;
}

/** Sessions root for this profile, honouring DSH_SESSIONS_DIR/DSH_HOME. */
export function sessionsRootOf(env = globalThis.process?.env ?? {}) {
  if (typeof env.DSH_SESSIONS_DIR === "string" && env.DSH_SESSIONS_DIR.length > 0) {
    return env.DSH_SESSIONS_DIR;
  }
  const home = typeof env.DSH_HOME === "string" && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/**
 * Cached ledger builder. Re-reads only logs whose mtime/size changed, and
 * recomputes at most once per `CACHE_MS`.
 */
export function createLedger({ prices, sessionsRoot, now = () => Date.now() }) {
  const rows = new Map();
  let builtAt = 0;
  return function ledger(force = false) {
    const clock = now();
    if (!force && clock - builtAt < CACHE_MS) return snapshot();
    builtAt = clock;
    for (const log of listSessionLogs(sessionsRoot)) {
      const previous = rows.get(log.file);
      if (previous !== undefined && previous.mtime === log.mtime && previous.size === log.size) continue;
      try {
        const row = readSessionBill(log.file, prices, log.sessionId);
        if (row === null) rows.delete(log.file);
        else rows.set(log.file, { ...row, mtime: log.mtime, size: log.size });
      } catch {
        // Unreadable logs are skipped rather than failing the whole ledger.
      }
    }
    return snapshot();
  };

  function snapshot() {
    const sessions = [...rows.values()]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_ROWS)
      .map(({ file, mtime, size, ...row }) => row);
    const totals = emptyBucket();
    const models = Object.create(null);
    const providers = Object.create(null);
    const dayAgg = Object.create(null);
    const merge = (target, source) => {
      for (const [key, bucket] of Object.entries(source)) {
        if (target[key] === undefined) target[key] = emptyBucket();
        target[key].input += bucket.input;
        target[key].cacheRead += bucket.cacheRead;
        target[key].output += bucket.output;
        target[key].cost += bucket.cost;
        target[key].messages += bucket.messages;
      }
    };
    for (const row of sessions) {
      mergeBucket(totals, row.totals);
      merge(models, row.models);
      merge(providers, row.providers);
      for (const [date, slice] of Object.entries(row.days ?? {})) {
        let agg = dayAgg[date];
        if (agg === undefined) {
          agg = dayAgg[date] = {
            totals: emptyBucket(),
            models: Object.create(null),
            providers: Object.create(null),
            sessions: Object.create(null),
          };
        }
        mergeBucket(agg.totals, slice.totals);
        merge(agg.models, slice.models);
        merge(agg.providers, slice.providers);
        let session = agg.sessions[row.sessionId];
        if (session === undefined) {
          session = agg.sessions[row.sessionId] = {
            id: row.sessionId,
            title: row.title,
            input: 0,
            cacheRead: 0,
            output: 0,
            cost: 0,
            messages: 0,
          };
        }
        mergeBucket(session, slice.totals);
        if (row.title) session.title = row.title;
      }
    }
    const dayRows = Object.entries(dayAgg)
      .map(([date, agg]) => ({
        date,
        totals: agg.totals,
        models: agg.models,
        providers: agg.providers,
        sessions: Object.values(agg.sessions).sort((a, b) => b.cost - a.cost),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return {
      generatedAt: Date.now(),
      sessionsRoot,
      sessions,
      totals,
      models,
      providers,
      days: dayRows,
      today: beijingDayKey(Date.now()),
    };
  }
}
