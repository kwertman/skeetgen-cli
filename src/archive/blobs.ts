import { access } from 'node:fs/promises';
import { join } from 'node:path';

import map_promises from 'p-map';

import { BskyXRPC } from '@mary/bluesky-client';
import { ResponseType, XRPCError, type XRPCResponse } from '@mary/bluesky-client/xrpc';

import { CID } from 'multiformats/cid';

import { get_cid_segment } from '../templates/utils/url.ts';

import { write_file_atomic } from '../utils/fs.ts';
import type { Logger } from '../utils/logger.ts';
import { sleep, with_timeout } from '../utils/misc.ts';

import type { DID } from './identity.ts';

const LIST_TIMEOUT = 90_000;
const BLOB_TIMEOUT = 5 * 60_000;

/** Downloads blobs that aren't in the archive yet, returns the number of blobs that couldn't be retrieved. */
export async function download_blobs(
	signal: AbortSignal,
	logger: Logger,
	pds: string,
	did: DID,
	blobs_dir: string,
): Promise<number> {
	const rpc = new BskyXRPC({ service: pds });

	let cids: string[] = [];
	let cursor: string | undefined;

	{
		using progress = logger.progress(`Retrieving list of blobs`);

		do {
			const response = await rpc.get('com.atproto.sync.listBlobs', {
				signal: with_timeout(signal, LIST_TIMEOUT),
				params: {
					did: did,
					cursor: cursor,
					limit: 1000,
				},
			});

			const data = response.data;

			cids = cids.concat(data.cids);
			cursor = data.cursor;

			progress.update(`Retrieving list of blobs (${cids.length} found)`);
		} while (cursor != null);
	}

	const get_blob_path = (cid: string) => {
		// These end up in a file path, and the list came from a remote server.
		return join(blobs_dir, get_cid_segment(CID.parse(cid).toString()));
	};

	const missing_cids: string[] = [];

	await map_promises(
		cids,
		async (cid) => {
			try {
				await access(get_blob_path(cid));
			} catch {
				missing_cids.push(cid);
			}
		},
		{ concurrency: 16, signal: signal },
	);

	const total = missing_cids.length;

	logger.log(`Found ${cids.length} blobs, ${total} to download`);

	let done = 0;
	let failed = 0;

	using progress = logger.progress(`Downloading blobs`);

	await map_promises(
		missing_cids,
		async (cid) => {
			let response: XRPCResponse<unknown>;
			let fails = 0;

			while (true) {
				try {
					response = await rpc.get('com.atproto.sync.getBlob', {
						signal: with_timeout(signal, BLOB_TIMEOUT),
						params: {
							did: did,
							cid: cid,
						},
					});
				} catch (err) {
					if (signal.aborted) {
						return;
					}

					if (err instanceof XRPCError) {
						// we got ratelimited, let's cool down
						if (err.status === ResponseType.RateLimitExceeded) {
							const rl_reset = err.headers?.['ratelimit-reset'];

							if (rl_reset !== undefined) {
								logger.warn(`Ratelimit exceeded, waiting`);

								// `ratelimit-reset` is in unix
								const reset_date = +rl_reset * 1_000;
								const now = Date.now();

								// add one second just to be sure
								const delta = reset_date - now + 1_000;

								await sleep(delta);
								continue;
							}
						} else if (err.status === ResponseType.InvalidRequest) {
							if (err.message === 'Blob not found') {
								logger.warn(`Tried to download nonexistent blob\n${cid}`);
								return;
							}
						}
					}

					// Retry 2 times before moving on, the next run will pick it up again.
					if (++fails < 3) {
						await sleep(fails * 1_000);
						continue;
					}

					failed++;
					logger.warn(`Failed to download blob ${cid}: ${(err as Error).message}`);
					return;
				}

				break;
			}

			await write_file_atomic(get_blob_path(cid), response.data as Uint8Array);

			progress.update(`Downloading blobs (${++done} of ${total})`);
		},
		{ concurrency: 2, signal: signal },
	);

	return failed;
}
