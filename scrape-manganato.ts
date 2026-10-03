#!/usr/bin/env bun
// Usage: bun scrape-manganato.ts <manga or chapter url> [options]

import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";

const SELECTOR = ".container-chapter-reader img";
const TIMEOUT_MS = 10_000;
const RETRIES = 5;
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

function computeBackoff(attempt: number, is429: boolean, retryAfterSec: number | null) {
  if (retryAfterSec && retryAfterSec > 0) {
    return retryAfterSec * 1000 + Math.floor(Math.random() * 500);
  }
  const base = is429 ? 3000 : 1000;
  const exp = Math.min(base * 2 ** (attempt - 1), 20_000);
  return exp + Math.floor(Math.random() * 500);
}

// throws after RETRIES failed attempts; the timeout covers the body download too
async function fetchWithRetry<T>(
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
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return await read(res);
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt >= RETRIES) {
        throw new Error(`${msg} (failed after ${RETRIES} attempts)`);
      }
      const backoff = computeBackoff(attempt, status === 429, retryAfterSec);
      console.warn(`↻ ${url}: ${msg} (retry ${attempt}/${RETRIES - 1}, waiting ${backoff}ms)`);
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
    const { data } = await fetchWithRetry(api, pageHeaders, (r) => r.json() as Promise<ChaptersResponse>);
    slugs.push(...data.chapters.map((c) => c.chapter_slug));
    if (!data.pagination.has_more || data.chapters.length === 0) break;
    offset += data.chapters.length;
  }
  return slugs.reverse();
}

async function scrapeChapter(chapterUrl: string, outDir: string, referer: string) {
  const html = await fetchWithRetry(chapterUrl, pageHeaders, (r) => r.text());

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

  console.log(`Found ${srcs.size} images`);
  if (srcs.size === 0) throw new Error("no images found on page");

  const failed: string[] = [];
  const limit = pLimit(10);
  await Promise.all(
    [...srcs].map((src) =>
      limit(async () => {
        const file = join(outDir, basename(new URL(src).pathname));
        if ((await Bun.file(file).exists()) && Bun.file(file).size > 0) {
          console.log(`- ${file} (exists)`);
          return;
        }
        try {
          const body = await fetchWithRetry(
            src,
            { ...imageHeaders, Referer: referer },
            (r) => r.arrayBuffer(),
          );
          // Bun.write creates the folder, so chapters with no successful images leave none behind
          await Bun.write(file, body);
          console.log(`✓ ${file}`);
        } catch (err) {
          console.error(`✗ ${src}: ${(err as Error).message}`);
          failed.push(basename(src));
        }
      }),
    ),
  );

  if (failed.length > 0) {
    throw new Error(`${failed.length} image(s) failed in ${outDir}: ${failed.join(", ")}`);
  }
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
  -o, --out <folder>   Output folder under out/ (default: manga slug)
      --from <chapter> First chapter to scrape, e.g. 10, 28.1 or chapter-28-1
      --to <chapter>   Last chapter to scrape
  -h, --help           Show help

Examples:
  bun scrape-manganato.ts https://www.manganato.gg/manga/jujutsu-kaisen -o jjk
  bun scrape-manganato.ts https://www.manganato.gg/manga/jujutsu-kaisen/chapter-1-5 --from 1.5 --to 10
  `.trim());
  process.exit(values.help ? 0 : 1);
}

const origin = new URL(inputUrl).origin;
const referer = `${origin}/`;
const baseDir = join("out", values.out ?? mangaSlug);

let chapters = await listChapters(origin, mangaSlug);
console.log(`${chapters.length} chapters in ${mangaSlug}`);

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

const failedChapters: string[] = [];

// one chapter at a time; each chapter already downloads its images in parallel
for (const chapter of chapters) {
  const url = `${origin}/manga/${mangaSlug}/${chapter}`;
  console.log(`\n== ${url}`);
  const outDir = join(baseDir, chapter.replace(/^chapter-/, "ch_"));

  try {
    await scrapeChapter(url, outDir, referer);
    errors.delete(url);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`✗ ${url}: ${msg}`);
    failedChapters.push(url);
    errors.set(url, msg);
  }
}

if (errors.size > 0) {
  await Bun.write(
    errorsFile,
    [...errors].map(([url, msg]) => `${url} ${msg}`).join("\n") + "\n",
  );
} else {
  await rm(errorsFile, { force: true });
}

if (failedChapters.length > 0) {
  console.error(
    `\nCompleted with ${failedChapters.length} failed chapter(s):\n${failedChapters.join("\n")}`,
  );
  process.exit(1);
} else {
  console.log(`\nDone! All ${chapters.length} chapters completed successfully.`);
}
