#!/usr/bin/env bun
// Usage: bun scrape-mangafire.ts <title or chapter url> [options]
/// <reference lib="dom" />

import { rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";
import { chromium, type Page } from "playwright";

const TIMEOUT_MS = 15_000;
const RETRIES = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0";

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

// throws after RETRIES failed attempts; the timeout covers the body download too
async function fetchWithRetry<T>(
  urlFor: string | ((attempt: number) => string),
  headers: Record<string, string>,
  read: (res: Response) => Promise<T>,
  onNoResponse?: (url: string) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const url = typeof urlFor === "string" ? urlFor : urlFor(attempt);
    let retryAfterSec: number | null = null;
    let status = 0;
    try {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const res = await fetch(url, { headers, signal }).catch((err) => {
        onNoResponse?.(url);
        throw err;
      });
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

// Pages are served from interchangeable mirrors (k99.mfcdn1.xyz, k99.mfcdn3.xyz, ...)
// and some of them can be unreachable from a given network. Retries rotate through the
// mirrors, a mirror that never answers is dropped for the rest of the run, and later
// images start from whichever mirror last worked.
const MIRROR_NUMBERS = [1, 2, 3];
let workingMirror: string | undefined;
const unreachableMirrors = new Set<string>();

function mirrorUrl(url: string, attempt: number) {
  const u = new URL(url);
  const mirrors = MIRROR_NUMBERS.map((n) => u.host.replace(/mfcdn\d+\./, `mfcdn${n}.`));
  const preferred = workingMirror && mirrors.includes(workingMirror) ? [workingMirror] : [];
  const hosts = [...new Set([...preferred, u.host, ...mirrors])];
  const live = hosts.filter((h) => !unreachableMirrors.has(h));
  const pool = live.length > 0 ? live : hosts;
  u.host = pool[(attempt - 1) % pool.length]!;
  return u.href;
}

function markUnreachable(url: string) {
  const host = new URL(url).host;
  if (/mfcdn\d+\./.test(host) && host !== workingMirror && !unreachableMirrors.has(host)) {
    unreachableMirrors.add(host);
    console.warn(`! ${host} is not answering, using the other mirrors`);
  }
}

type Params = Record<string, string | number>;

// Every API request needs a ?vrf= token computed by obfuscated code in the site's
// polyfill-*.js, which refuses to run outside a real browser. One of that module's
// exports installs an axios request interceptor that adds the token; we hand it a
// fake axios instance, keep the interceptor, and call it to sign each request.
async function createSigner(page: Page) {
  const found = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[href*="/polyfill-"]');
    if (!link) return false;
    const mod: Record<string, unknown> = await import(link.href);
    const g = globalThis as any;
    for (const fn of Object.values(mod)) {
      if (typeof fn !== "function" || g.__mfSign) continue;
      try {
        fn({
          interceptors: {
            request: { use: (f: unknown) => (g.__mfSign = f) },
            response: { use() {} },
          },
        });
      } catch {}
    }
    return typeof g.__mfSign === "function";
  });
  if (!found) throw new Error("couldn't find the vrf signer in the page (site changed?)");

  return (url: string, params: Params) =>
    page.evaluate(
      async ([url, params]) => {
        const config = await (globalThis as any).__mfSign({
          method: "get",
          baseURL: "/api",
          url,
          headers: {},
          params: { ...params },
        });
        return config.params.vrf as string;
      },
      [url, params] as const,
    );
}

interface ApiChapter {
  id: number;
  number: number;
}

interface ApiPage {
  url: string;
}

function toChapterNumber(s: string) {
  return Number(s.replace(/^chapter-/, "").replace("-", "."));
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string", short: "o" },
    from: { type: "string" },
    to: { type: "string" },
    lang: { type: "string", short: "l", default: "en" },
    headed: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

const inputUrl = positionals[0];
const titleMatch = inputUrl?.match(/\/title\/([a-z0-9]+)-([^/?#]+)/i);
if (values.help || !inputUrl || !titleMatch) {
  console.log(`
Usage: bun scrape-mangafire.ts <title or chapter url> [options]

Options:
  -o, --out <folder>   Output folder under out/ (default: title slug)
      --from <chapter> First chapter to scrape, e.g. 10, 141.1 or chapter-141-1
      --to <chapter>   Last chapter to scrape
  -l, --lang <code>    Chapter language (default: en)
      --headed         Show the browser window
  -h, --help           Show help

Chapters listed in out/<folder>/skip.txt (one per line, # for comments) are left out.

Examples:
  bun scrape-mangafire.ts https://mangafire.to/title/92kk8-naruto
  bun scrape-mangafire.ts https://mangafire.to/title/92kk8-naruto/chapter/1326884 --from 690 --to 700
  `.trim());
  process.exit(values.help ? 0 : 1);
}

const [, hid, slug] = titleMatch as [string, string, string];
const origin = new URL(inputUrl).origin;
const titleUrl = `${origin}/title/${hid}-${slug}`;
const baseDir = join("out", values.out ?? slug);

const browser = await chromium.launch({ headless: !values.headed, channel: "chrome" });
let exitCode = 0;
try {
  const page = await browser.newPage({ userAgent: UA });
  await page.route("**/*", (route) =>
    ["image", "font", "media"].includes(route.request().resourceType())
      ? route.abort()
      : route.continue(),
  );
  // only the polyfill <link> in the initial HTML is needed, so don't wait for the app's
  // scripts (domcontentloaded hangs whenever their CDN does)
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(titleUrl, { waitUntil: "commit" });
      await page.waitForSelector('link[href*="/polyfill-"]', { state: "attached" });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`↻ ${titleUrl}: ${(err as Error).message.split("\n")[0]} (retry ${attempt}/2)`);
    }
  }
  const sign = await createSigner(page);

  async function api<T>(path: string, params: Params = {}): Promise<T> {
    const query = new URLSearchParams(
      Object.entries({ ...params, vrf: await sign(path, params) }).map(([k, v]): [string, string] => [k, String(v)]),
    );
    return fetchWithRetry(
      `${origin}/api${path}?${query}`,
      {
        "User-Agent": UA,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Referer: titleUrl,
      },
      (r) => r.json() as Promise<T>,
    );
  }

  let chapters: ApiChapter[] = [];
  for (let p = 1; ; p++) {
    const { items, meta } = await api<{ items: ApiChapter[]; meta: { hasNext: boolean } }>(
      `/titles/${hid}/chapters`,
      { language: values.lang, sort: "number", order: "asc", page: p, limit: 200 },
    );
    chapters.push(...items);
    if (!meta.hasNext || items.length === 0) break;
  }
  // a chapter number can show up once per uploader; keep the first
  chapters = chapters.filter((c, i) => chapters.findIndex((o) => o.number === c.number) === i);
  console.log(`${chapters.length} ${values.lang} chapters in ${slug}`);

  for (const [flag, bound] of [["--from", values.from], ["--to", values.to]] as const) {
    if (bound && !chapters.some((c) => c.number === toChapterNumber(bound))) {
      throw new Error(`${flag} ${bound}: no such chapter`);
    }
  }
  const from = values.from ? toChapterNumber(values.from) : -Infinity;
  const to = values.to ? toChapterNumber(values.to) : Infinity;
  chapters = chapters.filter((c) => c.number >= from && c.number <= to);

  // skip.txt lists chapters to leave out (e.g. the same chapter uploaded twice by
  // different groups), one per line; text after # is a comment
  const skipFile = Bun.file(join(baseDir, "skip.txt"));
  if (await skipFile.exists()) {
    const skip = new Set(
      (await skipFile.text())
        .split("\n")
        .map((line) => line.replace(/#.*/, "").trim())
        .filter(Boolean)
        .map(toChapterNumber),
    );
    const skipped = chapters.filter((c) => skip.has(c.number)).map((c) => c.number);
    if (skipped.length > 0) console.log(`Skipping (skip.txt): ${skipped.join(", ")}`);
    chapters = chapters.filter((c) => !skip.has(c.number));
  }

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

  // one chapter at a time; each chapter downloads its images in parallel
  for (const chapter of chapters) {
    const url = `${titleUrl}/chapter/${chapter.id}`;
    console.log(`\n== ${url} (chapter ${chapter.number})`);
    const outDir = join(baseDir, `ch_${String(chapter.number).replace(".", "-")}`);

    try {
      const { data } = await api<{ data: { pages: ApiPage[] } }>(`/chapters/${chapter.id}`);
      console.log(`Found ${data.pages.length} images`);
      if (data.pages.length === 0) throw new Error("no images in chapter");

      const failed: string[] = [];
      const limit = pLimit(10);
      await Promise.all(
        data.pages.map((p, i) =>
          limit(async () => {
            // every page is served as .../p.jpg, so name files by page number instead
            const name = `${String(i + 1).padStart(3, "0")}${extname(new URL(p.url).pathname) || ".jpg"}`;
            const file = join(outDir, name);
            if ((await Bun.file(file).exists()) && Bun.file(file).size > 0) {
              console.log(`- ${file} (exists)`);
              return;
            }
            try {
              const body = await fetchWithRetry(
                (attempt) => mirrorUrl(p.url, attempt),
                { "User-Agent": UA, Accept: "image/*,*/*;q=0.8", Referer: `${origin}/` },
                async (r) => {
                  const buf = await r.arrayBuffer();
                  workingMirror = new URL(r.url).host;
                  return buf;
                },
                markUnreachable,
              );
              await Bun.write(file, body);
              console.log(`✓ ${file}`);
            } catch (err) {
              console.error(`✗ ${p.url}: ${(err as Error).message}`);
              failed.push(name);
            }
          }),
        ),
      );
      if (failed.length > 0) {
        throw new Error(`${failed.length} image(s) failed in ${outDir}: ${failed.join(", ")}`);
      }
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
    exitCode = 1;
  } else {
    console.log(`\nDone! All ${chapters.length} chapters completed successfully.`);
  }
} catch (err) {
  console.error((err as Error).message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
