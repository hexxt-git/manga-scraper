# manga-scraper

Downloads manga chapters from mangafire.to and manganato.gg, fetching chapters and images in parallel and resuming where a previous run stopped.

## Setup

```sh
bun install
```

`scrape-mangafire.ts` drives a local Google Chrome install through Playwright.

## Usage

```sh
bun scrape-manganato.ts https://www.manganato.gg/manga/jujutsu-kaisen --from 1 --to 10
bun scrape-mangafire.ts https://mangafire.to/title/92kk8-naruto --from 690 --to 700 -c 5
```

| Option | Description |
| --- | --- |
| `-o, --out <folder>` | Output folder under `out/` (default: title slug) |
| `--from <chapter>` | First chapter, e.g. `10` or `28.1` |
| `--to <chapter>` | Last chapter |
| `-c, --concurrency <n>` | Chapters downloaded in parallel (default: 3) |
| `-l, --lang <code>` | Chapter language, mangafire only (default: `en`) |
| `--headed` | Show the browser window, mangafire only |
| `-h, --help` | Show help |

## Concurrency

- Chapters download in parallel, set by `-c` (default 3).
- Each chapter downloads 10 images in parallel.
- With the defaults, up to 30 images download at once.

## Output

- Images are saved to `out/<folder>/ch_<n>/`.
- Images already on disk are skipped, so re-running resumes.
- Chapters that still fail after retries are listed in `out/<folder>/errors.txt`.
- mangafire only: chapters listed in `out/<folder>/skip.txt` (one per line, `#` for comments) are excluded.
