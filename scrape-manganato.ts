#!/usr/bin/env bun
// Usage: bun scrape-manganato.ts <manga or chapter url> [options]

import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";

const SELECTOR = ".container-chapter-reader img";
const TIMEOUT_MS = 10_000;
const RETRIES = 5;
const IMAGE_CONCURRENCY = 10;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0";

const imageHeaders = {
  "User-Agent": UA,
  Accept:
    "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
  "Accept-Language": "en-GB,en;q=0.9",
  "Sec-Fetch-Storage-Access": "none",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  "Sec-GPC": "1",
  Priority: "u=5, i",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
};

const pageHeaders = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

// Retry-After is only followed for 429s; Cloudflare also sends it with 5xx errors
// (e.g. Retry-After: 120 on a 521), where waiting it out doesn't help
const MAX_RETRY_AFTER_SEC = 125;

function computeBackoff(attempt: number, is429: boolean, retryAfterSec: number | null) {
  if (is429 && retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec, MAX_RETRY_AFTER_SEC) * 1000 + Math.floor(Math.random() * 500);
  }
  const base = is429 ? 3000 : 1000;
  const exp = Math.min(base * 2 ** (attempt - 1), 20_000);
  return exp + Math.floor(Math.random() * 500);
}

function httpError(res: Response) {
  // Bun reports "<none>" as the status text for codes it has no name for (e.g. 521)
  const text = res.statusText && res.statusText !== "<none>" ? ` ${res.statusText}` : "";
  return new Error(`HTTP ${res.status}${text}`);
}

let rateLimitNoticeShown = false;

// throws the last error after RETRIES failed attempts; the timeout covers the body
// download too. Retries are silent apart from a one-off notice the first time the
// site rate-limits us, since those waits can be long.
// `label` names the request in that notice, e.g. "ch_42/3.webp".
async function fetchWithRetry<T>(
  label: string,
  url: string,
  headers: Record<string, string>,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let retryAfterSec: number | null = null;
    let status = 0;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        status = res.status;
        retryAfterSec = parseInt(res.headers.get("retry-after") ?? "", 10) || null;
        throw httpError(res);
      }
      return await read(res);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      const backoff = computeBackoff(attempt, status === 429, retryAfterSec);
      if (status === 429 && !rateLimitNoticeShown) {
        rateLimitNoticeShown = true;
        console.warn(
          `⏸ ${label}: rate limited (HTTP 429), waiting ${Math.round(backoff / 1000)}s; retries may be slow for a while`,
        );
      }
      await Bun.sleep(backoff);
    }
  }
}

interface ApiChapter {
  chapter_slug: string;
}

interface ChaptersResponse {
  data: {
    chapters: ApiChapter[];
    pagination: { has_more: boolean };
  };
}

// same list as the reader's #chapter-dropdown, oldest first
async function listChapters(origin: string, slug: string): Promise<string[]> {
  const slugs: string[] = [];
  for (let offset = 0; ; ) {
    const api = `${origin}/api/manga/${slug}/chapters?limit=500&offset=${offset}`;
    const { data } = await fetchWithRetry("chapter list", api, pageHeaders, (r) => r.json() as Promise<ChaptersResponse>);
    slugs.push(...data.chapters.map((c) => c.chapter_slug));
    if (!data.pagination.has_more || data.chapters.length === 0) break;
    offset += data.chapters.length;
  }
  return slugs.reverse();
}

async function scrapeChapter(chapterUrl: string, outDir: string, folder: string, referer: string) {
  const html = await fetchWithRetry(`${folder} page`, chapterUrl, pageHeaders, (r) => r.text()).catch(
    (err) => {
      throw new Error(`couldn't load the chapter page: ${(err as Error).message}`);
    },
  );

  const srcs = new Set<string>();
  new HTMLRewriter()
    .on(SELECTOR, {
      element(el) {
        // lazy-loaded images keep the real URL in data-src and a placeholder in src
        const src = el.getAttribute("data-src") ?? el.getAttribute("src");
        if (!src) return;
        try {
          const url = new URL(src, chapterUrl);
          if (url.protocol === "https:") srcs.add(url.href);
        } catch {}
      },
    })
    .transform(html);

  if (srcs.size === 0) throw new Error("no images found on page");

  let downloaded = 0;
  const failed: { name: string; reason: string }[] = [];
  const limit = pLimit(IMAGE_CONCURRENCY);
  await Promise.all(
    [...srcs].map((src) =>
      limit(async () => {
        const name = basename(new URL(src).pathname);
        const file = join(outDir, name);
        if ((await Bun.file(file).exists()) && Bun.file(file).size > 0) return;
        try {
          const body = await fetchWithRetry(
            `${folder}/${name}`,
            src,
            { ...imageHeaders, Referer: referer },
            (r) => r.arrayBuffer(),
          );
          // Bun.write creates the folder, so chapters with no successful images leave none behind
          await Bun.write(file, body);
          downloaded++;
        } catch (err) {
          failed.push({ name, reason: (err as Error).message });
        }
      }),
    ),
  );

  if (failed.length > 0) {
    throw imageFailure(srcs.size, failed);
  }
  return { images: srcs.size, downloaded };
}

// one line for the console ("3 of 40 images failed: HTTP 503") and the file names for errors.txt
function imageFailure(total: number, failed: { name: string; reason: string }[]) {
  const counts = new Map<string, number>();
  for (const f of failed) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
  const reasons =
    counts.size === 1
      ? [...counts.keys()][0]
      : [...counts].map(([reason, n]) => `${n}× ${reason}`).join(", ");
  return new Error(`${failed.length} of ${total} images failed: ${reasons}`, {
    cause: failed
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(", "),
  });
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// "chapter-28.1", "28.1" and "28-1" all -> "chapter-28-1"
function toChapterSlug(s: string) {
  return `chapter-${s.replace(/^chapter-/, "").replaceAll(".", "-")}`;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string", short: "o" },
    from: { type: "string" },
    to: { type: "string" },
    concurrency: { type: "string", short: "c", default: "3" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const inputUrl = positionals[0];
const mangaSlug = inputUrl?.match(/\/manga\/([^/?#]+)/)?.[1];
if (values.help || !inputUrl || !mangaSlug) {
  console.log(`
Usage: bun scrape-manganato.ts <manga or chapter url> [options]

Options:
  -o, --out <folder>       Output folder under out/ (default: manga slug)
      --from <chapter>     First chapter to scrape, e.g. 10, 28.1 or chapter-28-1
      --to <chapter>       Last chapter to scrape
  -c, --concurrency <n>    Chapters to download at the same time (default: 3)
  -h, --help               Show help

Examples:
  bun scrape-manganato.ts https://www.manganato.gg/manga/jujutsu-kaisen -o jjk
  bun scrape-manganato.ts https://www.manganato.gg/manga/jujutsu-kaisen/chapter-1-5 --from 1.5 --to 10 -c 5
  `.trim());
  process.exit(values.help ? 0 : 1);
}

const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error(`--concurrency must be a whole number of at least 1 (got "${values.concurrency}")`);
  process.exit(1);
}

const origin = new URL(inputUrl).origin;
const referer = `${origin}/`;
const baseDir = join("out", values.out ?? mangaSlug);

let chapters = await listChapters(origin, mangaSlug).catch((err) => {
  console.error(`Couldn't load the chapter list: ${(err as Error).message}`);
  process.exit(1);
});
console.log(`Found ${plural(chapters.length, "chapter")} of ${mangaSlug}`);

for (const [flag, bound] of [["--from", values.from], ["--to", values.to]] as const) {
  if (bound && !chapters.includes(toChapterSlug(bound))) {
    console.error(`${flag} ${bound}: no such chapter`);
    process.exit(1);
  }
}
const start = values.from ? chapters.indexOf(toChapterSlug(values.from)) : 0;
const end = values.to ? chapters.indexOf(toChapterSlug(values.to)) + 1 : chapters.length;
chapters = chapters.slice(start, end);

// errors.txt holds one "<url> <error>" line per chapter still failing after retries
const errorsFile = join(baseDir, "errors.txt");
const errors = new Map<string, string>();
if (await Bun.file(errorsFile).exists()) {
  for (const line of (await Bun.file(errorsFile).text()).split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0) errors.set(line.slice(0, i), line.slice(i + 1));
  }
}

const folderOf = (chapter: string) => chapter.replace(/^chapter-/, "ch_");

console.log(
  `Downloading ${plural(chapters.length, "chapter")} to ${baseDir}/, ${concurrency} at a time\n`,
);

const counterWidth = String(chapters.length).length;
const folderWidth = Math.max(0, ...chapters.map((c) => folderOf(c).length));
let finished = 0;
let totalImages = 0;
let totalDownloaded = 0;
const failedChapters: string[] = [];

const chapterLimit = pLimit(concurrency);
await Promise.all(
  chapters.map((chapter) =>
    chapterLimit(async () => {
      const url = `${origin}/manga/${mangaSlug}/${chapter}`;
      const folder = folderOf(chapter);
      let line: string;
      try {
        const { images, downloaded } = await scrapeChapter(url, join(baseDir, folder), folder, referer);
        totalImages += images;
        totalDownloaded += downloaded;
        errors.delete(url);
        line =
          downloaded === 0
            ? `✓ ${plural(images, "image")}, all already saved`
            : downloaded === images
              ? `✓ ${plural(images, "image")} downloaded`
              : `✓ ${plural(images, "image")} (${downloaded} downloaded, ${images - downloaded} already saved)`;
      } catch (err) {
        const msg = (err as Error).message;
        failedChapters.push(chapter);
        const { cause } = err as Error;
        errors.set(url, cause ? `${msg} (${cause})` : msg);
        line = `✗ ${msg}`;
      }
      finished++;
      const counter = `[${String(finished).padStart(counterWidth)}/${chapters.length}]`;
      console.log(`${counter} ${folder.padEnd(folderWidth)}  ${line}`);
    }),
  ),
);

if (errors.size > 0) {
  await Bun.write(
    errorsFile,
    [...errors].map(([url, msg]) => `${url} ${msg}`).join("\n") + "\n",
  );
} else {
  await rm(errorsFile, { force: true });
}

if (failedChapters.length > 0) {
  failedChapters.sort((a, b) => chapters.indexOf(a) - chapters.indexOf(b));
  console.error(
    `\n${failedChapters.length} of ${plural(chapters.length, "chapter")} failed (also saved to ${errorsFile}; run again to retry them):\n` +
      failedChapters.map((c) => `  ${folderOf(c).padEnd(folderWidth)}  ${origin}/manga/${mangaSlug}/${c}`).join("\n"),
  );
  process.exit(1);
} else {
  console.log(
    `\nDone: ${plural(chapters.length, "chapter")}, ${plural(totalImages, "image")} (${totalDownloaded} downloaded, ${totalImages - totalDownloaded} already saved)`,
  );
}
