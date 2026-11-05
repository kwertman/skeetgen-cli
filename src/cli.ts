import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { sync_archive } from './archive/sync.ts';
import { Logger } from './utils/logger.ts';

const USAGE = `Keeps a local, browsable archive of a Bluesky account's posts.

Usage: skeetgen <handle or did> [options]

Options:
  -o, --out <dir>  Directory to keep the archive in (default: ./bluesky-archive)
      --no-media   Don't download images and other media
  -h, --help       Show this message
`;

async function main(): Promise<number> {
	let args;

	try {
		args = parseArgs({
			allowPositionals: true,
			options: {
				out: { type: 'string', short: 'o', default: 'bluesky-archive' },
				'no-media': { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		});
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
		return 2;
	}

	const { values, positionals } = args;

	if (values.help) {
		process.stdout.write(USAGE);
		return 0;
	}

	if (positionals.length !== 1) {
		process.stderr.write(USAGE);
		return 2;
	}

	const controller = new AbortController();
	const signal = controller.signal;

	const logger = new Logger();

	process.once('SIGINT', () => controller.abort());
	process.once('SIGTERM', () => controller.abort());

	try {
		const failed_blobs = await sync_archive({
			signal: signal,
			logger: logger,
			identifier: positionals[0].replace(/^@/, ''),
			out_dir: resolve(values.out),
			with_media: !values['no-media'],
		});

		if (failed_blobs > 0) {
			logger.error(
				`Finished, but ${failed_blobs} blobs couldn't be downloaded, the next run will retry them`,
			);
			return 1;
		}

		logger.log(`Finished`);
		return 0;
	} catch (err) {
		if (signal.aborted) {
			logger.warn(`Interrupted, run this again to pick up where it left off`);
			return 130;
		}

		logger.error((err as Error).message);
		return 1;
	}
}

process.exitCode = await main();
