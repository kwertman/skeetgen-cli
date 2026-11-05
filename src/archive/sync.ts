import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getPdsEndpoint, type DidDocument } from '@mary/bluesky-client';

import { write_file_atomic } from '../utils/fs.ts';
import type { Logger } from '../utils/logger.ts';

import { download_blobs } from './blobs.ts';
import { describe_images } from './descriptions.ts';
import { resolve_did, retrieve_did_document, type DID } from './identity.ts';
import { download_repo, load_stored_records, read_repo_records, save_stored_records } from './repository.ts';
import { render_site } from './site.ts';

export interface SyncOptions {
	signal: AbortSignal;
	logger: Logger;
	identifier: string;
	out_dir: string;
	with_media: boolean;
	/** Vision model to describe images with, images aren't described if unset. */
	describe_model: string | undefined;
}

/** Brings the archive up to date, returns how many blobs and image descriptions couldn't be retrieved. */
export async function sync_archive({
	signal,
	logger,
	identifier,
	out_dir,
	with_media,
	describe_model,
}: SyncOptions) {
	const did_path = join(out_dir, 'data/did.json');
	const car_path = join(out_dir, 'data/repo.car');
	const records_path = join(out_dir, 'data/records.cbor');

	logger.log(`Syncing ${identifier} to ${out_dir}`);

	// 1. Resolve the user's identity
	const did = await resolve_did(signal, logger, identifier);

	await assert_same_owner(did_path, did);

	const doc = await retrieve_did_document(signal, logger, did);
	const pds = getPdsEndpoint(doc);

	if (!pds) {
		throw new Error(`This user is not registered to any Bluesky PDS.`);
	}

	logger.log(`User is located on ${new URL(pds).hostname}`);

	// 2. Download the repository, nothing in the archive gets touched until we
	// know that we've gotten a repository that can be read in full.
	const car_buf = await download_repo(signal, logger, pds, did);
	const repo_records = await read_repo_records(car_buf, did);

	// 3. Merge it with what we have, posts deleted since the last sync are kept.
	const stored_records = await load_stored_records(records_path);
	const records = new Map([...stored_records, ...repo_records]);

	await write_file_atomic(did_path, JSON.stringify(doc));
	await write_file_atomic(car_path, car_buf);
	await save_stored_records(records_path, records);

	// 4. Download any new media
	let failed_blobs = 0;
	if (with_media) {
		failed_blobs = await download_blobs(signal, logger, pds, did, join(out_dir, 'blobs'));
	}

	// 5. Describe any new images
	let failed_descriptions = 0;
	if (describe_model !== undefined) {
		failed_descriptions = await describe_images(signal, logger, out_dir, records, describe_model);
	}

	// 6. Generate pages
	const post_count = await render_site(signal, logger, out_dir, doc, records);

	const is_post = (key: string) => key.startsWith('app.bsky.feed.post/');
	const live_count = [...repo_records.keys()].filter(is_post).length;

	logger.log(`Archive has ${post_count} posts, ${post_count - live_count} of them no longer on Bluesky`);

	return { failed_blobs, failed_descriptions };
}

export interface RenderOptions {
	signal: AbortSignal;
	logger: Logger;
	out_dir: string;
	/** Vision model to describe images with, images aren't described if unset. */
	describe_model: string | undefined;
}

/**
 * Regenerates the pages using only what's already in the archive, returns how
 * many image descriptions couldn't be retrieved.
 */
export async function render_archive({ signal, logger, out_dir, describe_model }: RenderOptions) {
	let doc: DidDocument;

	try {
		doc = JSON.parse(await readFile(join(out_dir, 'data/did.json'), 'utf8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`No archive found in ${out_dir}, sync an account to it first.`);
		}

		throw err;
	}

	const records = await load_stored_records(join(out_dir, 'data/records.cbor'));

	let failed_descriptions = 0;
	if (describe_model !== undefined) {
		failed_descriptions = await describe_images(signal, logger, out_dir, records, describe_model);
	}

	const post_count = await render_site(signal, logger, out_dir, doc, records);

	logger.log(`Rendered ${post_count} posts to ${out_dir}`);

	return failed_descriptions;
}

async function assert_same_owner(did_path: string, did: DID) {
	let existing: DidDocument;

	try {
		existing = JSON.parse(await readFile(did_path, 'utf8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return;
		}

		throw err;
	}

	if (existing.id !== did) {
		throw new Error(`This archive belongs to ${existing.id}, not ${did}. Use a different output directory.`);
	}
}
