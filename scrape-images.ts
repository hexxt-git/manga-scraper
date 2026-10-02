#!/usr/bin/env bun
// Usage: bun scrape-images.ts <url> [outDir]

import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";

export interface ScrapeOptions {
  outDir?: string;
  selector?: string;
  container?: string;
  referer?: string;
}

export function normalizeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!/\bimg\b/i.test(trimmed)) {
    return `${trimmed} img`;
  }
  return trimmed;
}

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0",
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

const TIMEOUT_MS = 10_000;
const RETRIES = 5;

function computeBackoff(attempt: number, is429: boolean, retryAfterSec?: number | null) {
  if (retryAfterSec && retryAfterSec > 0) {
    return retryAfterSec * 1000 + Math.floor(Math.random() * 500);
  }
  const base = is429 ? 3000 : 1000;
  const exp = Math.min(base * 2 ** (attempt - 1), 20_000);
  const jitter = Math.floor(Math.random() * 500);
  return exp + jitter;
}

export async function scrapeImages(
  pageUrl: string,
  outDirOrOptions?: string | ScrapeOptions,
  options?: ScrapeOptions,
) {
  const opts: ScrapeOptions =
    typeof outDirOrOptions === "string"
      ? { outDir: outDirOrOptions, ...options }
      : { ...outDirOrOptions };

  // default: last -<number> in the URL, e.g. .../chapter-200.5/ -> ch_200-5
  const num = [...pageUrl.matchAll(/-([\d.]+)/g)].at(-1)?.[1];
  const defaultFolder = num ? `ch_${num.replaceAll(".", "-")}` : "images";
  const outDir = opts.outDir
    ? opts.outDir.startsWith("out/") || opts.outDir === "out"
      ? opts.outDir
      : join("out", opts.outDir)
    : join("out", defaultFolder);

  let res: Response | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(pageUrl, {
        headers: {
          "User-Agent": headers["User-Agent"],
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        const sec = retryAfter ? parseInt(retryAfter, 10) : null;
        throw new Error(`${res.status} ${res.statusText}${sec ? ` (retry-after: ${sec}s)` : ""}`);
      }
      break;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt >= RETRIES) {
        throw new Error(`Failed to fetch page after ${RETRIES} attempts: ${msg}`);
      }
      const is429 = msg.includes("429");
      const retryAfterMatch = msg.match(/retry-after:\s*(\d+)s/);
      const retryAfterSec = retryAfterMatch?.[1] ? parseInt(retryAfterMatch[1], 10) : null;
      const backoff = computeBackoff(attempt, is429, retryAfterSec);
      console.warn(`↻ ${pageUrl}: ${msg} (retry ${attempt}/${RETRIES - 1}, waiting ${Math.round(backoff)}ms)`);
      await Bun.sleep(backoff);
    }
  }

  const rawSelector = opts.selector ?? opts.container;
  if (!rawSelector) {
    throw new Error(
      "Missing selector: please specify a query selector or container class (e.g. -s '.container img' or -c '.container')",
    );
  }
  const selector = normalizeSelector(rawSelector);

  const fallbackOrigin = `${new URL(res!.url).origin}/`;
  const imageReferer = opts.referer ?? fallbackOrigin;
  const srcs = new Set<string>();

  await new HTMLRewriter()
    .on(selector, {
      element(el) {
        // lazy-loaded images keep the real URL in data-src and a placeholder in src
        const src = el.getAttribute("data-src") ?? el.getAttribute("src");
        if (!src) return;
        try {
          const url = new URL(src, pageUrl);
          if (url.protocol === "https:") srcs.add(url.href);
        } catch {}
      },
    })
    .transform(res!)
    .arrayBuffer(); // consume the stream so handlers run

  console.log(`Found ${srcs.size} https images`);
  if (srcs.size === 0) return;

  await mkdir(outDir, { recursive: true });

  const used = new Set<string>();
  function fileNameFor(url: string, i: number, contentType: string | null) {
    let name = basename(new URL(url).pathname) || `image-${i}`;
    if (!extname(name) && contentType?.startsWith("image/")) {
      const sub = contentType.split("/")[1]?.split(";")[0];
      if (sub) {
        name += "." + sub.replace("jpeg", "jpg").replace("svg+xml", "svg");
      }
    }
    let candidate = name;
    let n = 1;
    while (used.has(candidate)) {
      const ext = extname(name);
      candidate = `${name.slice(0, name.length - ext.length)}-${n++}${ext}`;
    }
    used.add(candidate);
    return candidate;
  }

  const limit = pLimit(10);

  const failed: { src: string; error: string }[] = [];

  async function download(src: string, i: number) {
    // skip images already downloaded by a previous run
    const existing = join(outDir, basename(new URL(src).pathname));
    if (extname(existing) && (await Bun.file(existing).exists()) && (await Bun.file(existing).size) > 0) {
      console.log(`- ${existing} (exists)`);
      return;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        // timeout covers the whole request including the body download
        const imgRes = await fetch(src, {
          headers: { ...headers, Referer: imageReferer },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!imgRes.ok) {
          const retryAfter = imgRes.headers.get("retry-after");
          const sec = retryAfter ? parseInt(retryAfter, 10) : null;
          throw new Error(`${imgRes.status} ${imgRes.statusText}${sec ? ` (retry-after: ${sec}s)` : ""}`);
        }
        const body = await imgRes.arrayBuffer();
        const file = join(
          outDir,
          fileNameFor(src, i, imgRes.headers.get("content-type")),
        );
        await Bun.write(file, body);
        console.log(`✓ ${file}`);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt >= RETRIES) {
          console.error(`✗ ${src}: ${msg} (failed after ${RETRIES} attempts)`);
          failed.push({ src, error: msg });
          return;
        }
        const is429 = msg.includes("429");
        const retryAfterMatch = msg.match(/retry-after:\s*(\d+)s/);
        const retryAfterSec = retryAfterMatch?.[1] ? parseInt(retryAfterMatch[1], 10) : null;
        const backoff = computeBackoff(attempt, is429, retryAfterSec);
        console.warn(`↻ ${src}: ${msg} (retry ${attempt}/${RETRIES - 1}, waiting ${Math.round(backoff)}ms)`);
        await Bun.sleep(backoff);
      }
    }
  }

  await Promise.all(
    [...srcs].map((src, i) => limit(() => download(src, i + 1))),
  );

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} image(s) failed in ${outDir}: ${failed.map((f) => basename(f.src)).join(", ")}`,
    );
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      outDir: { type: "string", short: "o" },
      selector: { type: "string", short: "s" },
      container: { type: "string", short: "c" },
      referer: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
Usage: bun scrape-images.ts <url> [outDir] [options]

Options:
  -s, --selector <query>   Query selector for images (e.g. '.container-chapter-reader img')
  -c, --container <query>  Container selector shorthand (appends ' img')
  -r, --referer <url>      Referer header for image requests (default: page origin)
  -o, --outDir <path>      Output directory (default: out/ch_<number>)
  -h, --help               Show help

Examples:
  bun scrape-images.ts https://www.manganato.gg/manga/naruto/chapter-1 -s ".container-chapter-reader img" -r "https://www.manganato.gg/"
  bun scrape-images.ts https://www.manganato.gg/manga/naruto/chapter-1 -c ".container-chapter-reader" -r "https://www.manganato.gg/"
  bun scrape-images.ts https://example.com/chapter-1 out/ch_1 -s "img.chapter-img"
    `.trim());
    process.exit(values.help ? 0 : 1);
  }

  const [pageUrl, positionalOutDir] = positionals;
  const rawSelector = values.selector ?? values.container;
  if (!rawSelector) {
    console.error("Error: --selector (-s) or --container (-c) is required");
    process.exit(1);
  }

  await scrapeImages(pageUrl, {
    outDir: values.outDir ?? positionalOutDir,
    selector: rawSelector,
    referer: values.referer,
  });
}
