# skeetgen

A command line tool that keeps a local, browsable archive of a Bluesky account's posts. Run it as often as
you like: each run updates the same archive, and only downloads media it doesn't have yet.

Forked from [mary's skeetgen](https://codeberg.org/mary-ext/skeetgen), which runs in the browser.

## Setup

Requires Node.js 22 or newer.

```bash
pnpm install
pnpm run build
pnpm link --global # optional, makes `skeetgen` available everywhere
```

Without the global link, use `node dist/cli.js` in place of `skeetgen`.

### Standalone executable

To get a single binary that doesn't need Node.js or anything else from this project to run:

```bash
pnpm run compile
```

This creates `dist/skeetgen`, which you can copy anywhere on your `PATH`, and which also works in place of
`/absolute/path/to/node /absolute/path/to/skeetgen/dist/cli.js` in the scheduling examples below. It's around
90 MB as it includes a JavaScript runtime ([Bun](https://bun.sh)), and it only runs on the OS and CPU it was
built on. Recompile to pick up any changes.

## Usage

```bash
skeetgen your-handle.bsky.social --out ~/bluesky-archive
```

| Option         | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `-o`, `--out`  | Directory to keep the archive in, defaults to `./bluesky-archive`    |
| `--no-media`   | Don't download images and other media, images will show up as broken |
| `-h`, `--help` | Show usage                                                           |

Only public data is read, so no login is needed. Open `index.html` in the archive to browse it, no server is
necessary.

The exit code is `0` on success, `1` if the sync failed or some media couldn't be downloaded (those will be
retried on the next run), `2` on incorrect usage, and `130` if interrupted. Running it again after a failure
is always safe, the existing archive is left as is until a full copy of the repository has been downloaded.

To regenerate the pages from what's already in the archive, without downloading anything:

```bash
skeetgen render --out ~/bluesky-archive
```

## What's in the archive

```
index.html, search.html   start here
timeline/, posts/         generated pages, rewritten on every run
assets/                   stylesheet and search script
blobs/                    images and other media, named by their CID
data/did.json             the account's DID document
data/repo.car             the latest full copy of the account's repository, as served by its PDS
data/records.cbor         every post, profile, feed, list and threadgate record seen so far
```

**Deleted posts stay in the archive.** Records are only ever added to or updated in `data/records.cbor`, so a
post you delete on Bluesky stays in your archive, as does its media. To really remove one, delete the archive
directory and sync again.

Each archive belongs to a single account, syncing a different account to the same directory is an error.

Video posts are archived in `data/` and `blobs/`, but the generated pages don't display the video.

## Running it periodically

### launchd (macOS)

Save this as `~/Library/LaunchAgents/skeetgen.plist`, using absolute paths for everything:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
		<key>Label</key>
		<string>skeetgen</string>
		<key>ProgramArguments</key>
		<array>
			<string>/absolute/path/to/node</string>
			<string>/absolute/path/to/skeetgen/dist/cli.js</string>
			<string>your-handle.bsky.social</string>
			<string>--out</string>
			<string>/Users/you/bluesky-archive</string>
		</array>
		<key>StartCalendarInterval</key>
		<dict>
			<key>Hour</key>
			<integer>3</integer>
			<key>Minute</key>
			<integer>0</integer>
		</dict>
		<key>StandardErrorPath</key>
		<string>/Users/you/bluesky-archive.log</string>
	</dict>
</plist>
```

Then load it with `launchctl load ~/Library/LaunchAgents/skeetgen.plist`. If your Mac is asleep at the
scheduled time, launchd runs the job when it wakes up.

### cron

```
0 3 * * * /absolute/path/to/node /absolute/path/to/skeetgen/dist/cli.js your-handle.bsky.social --out "$HOME/bluesky-archive" 2>> "$HOME/bluesky-archive.log"
```

## Development

- `pnpm run build` type checks and builds everything into `dist/cli.js`
- `pnpm run fmt` formats the code

Rendering lives in `src/templates`, archive styling and the search page's script live in `src_templates`.

The stylesheet and templates are bundled into `dist/cli.js`, so to try out a design change, rebuild and render:

```bash
pnpm run build && node dist/cli.js render --out ~/bluesky-archive
```
