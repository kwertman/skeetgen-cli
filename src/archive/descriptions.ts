import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppBskyFeedPost } from '@mary/bluesky-client/lexicons';

import { CID } from 'multiformats/cid';

import { get_blob_str } from '../templates/context.ts';
import { get_post_images } from '../templates/utils/embed.ts';
import { get_cid_segment } from '../templates/utils/url.ts';

import { write_file_atomic } from '../utils/fs.ts';
import type { Logger } from '../utils/logger.ts';
import { with_timeout } from '../utils/misc.ts';

import type { RecordMap } from './repository.ts';

/** Image descriptions keyed by the image's CID */
export type ImageDescriptions = Map<string, string>;

export const DEFAULT_MODEL = 'gemma3:12b-it-q4_K_M';

const OLLAMA_URL = 'http://127.0.0.1:11434';

const REQUEST_TIMEOUT = 30_000;
// Generous, the model might need to be loaded into memory first.
const DESCRIBE_TIMEOUT = 10 * 60_000;

const PROMPT =
	`Describe this image so that it can be found with a text search. ` +
	`Cover the main subjects, the setting, notable objects and colors, and transcribe any visible text. ` +
	`Reply with only the description, as plain text.`;

const get_descriptions_path = (out_dir: string) => join(out_dir, 'data/image-descriptions.json');

export async function load_image_descriptions(out_dir: string): Promise<ImageDescriptions> {
	let json: string;

	try {
		json = await readFile(get_descriptions_path(out_dir), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return new Map();
		}

		throw err;
	}

	return new Map(Object.entries(JSON.parse(json) as Record<string, string>));
}

/** Describes images that don't have a description yet, returns the number of images left without one. */
export async function describe_images(
	signal: AbortSignal,
	logger: Logger,
	out_dir: string,
	records: RecordMap,
	model: string,
): Promise<number> {
	const descriptions = await load_image_descriptions(out_dir);

	const cids = new Set<string>();

	for (const [key, record] of records) {
		if (key.startsWith('app.bsky.feed.post/')) {
			for (const img of get_post_images(record as AppBskyFeedPost.Record) ?? []) {
				const cid = get_blob_str(img.image);

				if (!descriptions.has(cid)) {
					cids.add(cid);
				}
			}
		}
	}

	const total = cids.size;

	logger.log(`Found ${total} images to describe`);

	if (total === 0) {
		return 0;
	}

	// Don't go through every image just to find out that none of them will work.
	const problem = await check_model(signal, model);

	if (problem !== undefined) {
		logger.warn(`Unable to describe images: ${problem}`);
		return total;
	}

	let done = 0;
	let failed = 0;

	using progress = logger.progress(`Describing images`);

	for (const cid of cids) {
		progress.update(`Describing images (${done + failed + 1} of ${total})`);

		try {
			// Blobs that are referenced by records aren't guaranteed to be downloaded.
			const path = join(out_dir, 'blobs', get_cid_segment(CID.parse(cid).toString()));
			const image = await readFile(path);

			descriptions.set(cid, await describe_image(signal, model, image));
		} catch (err) {
			signal.throwIfAborted();

			failed++;
			logger.warn(`Failed to describe image ${cid}: ${(err as Error).message}`);
			continue;
		}

		done++;

		// This is slow going, so don't lose any of it if we get interrupted.
		await write_file_atomic(get_descriptions_path(out_dir), JSON.stringify(Object.fromEntries(descriptions)));
	}

	logger.log(`Described ${done} images`);

	return failed;
}

async function check_model(signal: AbortSignal, model: string): Promise<string | undefined> {
	let response: Response;

	try {
		response = await fetch(`${OLLAMA_URL}/api/show`, {
			signal: with_timeout(signal, REQUEST_TIMEOUT),
			method: 'POST',
			body: JSON.stringify({ model: model }),
		});
	} catch (err) {
		signal.throwIfAborted();
		return `Ollama isn't reachable at ${OLLAMA_URL}, is it running?`;
	}

	if (response.status === 404) {
		return `model ${model} isn't installed, run \`ollama pull ${model}\``;
	} else if (!response.ok) {
		return `Ollama responded with error ${response.status}`;
	}

	const data = (await response.json()) as { capabilities?: string[] };

	// A model without vision would make up descriptions without having seen the image.
	if (data.capabilities !== undefined && !data.capabilities.includes('vision')) {
		return `model ${model} doesn't support images`;
	}
}

async function describe_image(signal: AbortSignal, model: string, image: Uint8Array) {
	const response = await fetch(`${OLLAMA_URL}/api/generate`, {
		signal: with_timeout(signal, DESCRIBE_TIMEOUT),
		method: 'POST',
		body: JSON.stringify({
			model: model,
			prompt: PROMPT,
			images: [Buffer.from(image).toString('base64')],
			stream: false,
			// Ollama's default is too small for large images on some models.
			options: { num_ctx: 8192 },
		}),
	});

	if (!response.ok) {
		throw new Error(`Ollama responded with error ${response.status}: ${await response.text()}`);
	}

	const data = (await response.json()) as { response: string };
	const description = data.response.trim();

	if (!description) {
		throw new Error(`model returned an empty description`);
	}

	return description;
}
