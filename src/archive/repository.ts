import { readFile } from 'node:fs/promises';

import { CarBlockIterator } from '@ipld/car';
import { decode as decode_cbor, encode as encode_cbor } from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';

import { format_bytes } from '../utils/format-bytes.ts';
import { write_file_atomic } from '../utils/fs.ts';
import type { Logger } from '../utils/logger.ts';
import { assert, iterate_stream, with_timeout } from '../utils/misc.ts';

import type { DID } from './identity.ts';

/** Records keyed by `collection/rkey` */
export type RecordMap = Map<string, unknown>;

const decoder = new TextDecoder();

const REPO_TIMEOUT = 15 * 60_000;

// The collections that the generated pages are able to make use of.
const ARCHIVED_COLLECTIONS = new Set([
	'app.bsky.actor.profile',
	'app.bsky.feed.generator',
	'app.bsky.feed.post',
	'app.bsky.feed.threadgate',
	'app.bsky.graph.list',
]);

export async function download_repo(signal: AbortSignal, logger: Logger, pds: string, did: DID) {
	using progress = logger.progress(`Downloading repository`);

	const response = await fetch(`${pds}/xrpc/com.atproto.sync.getRepo?did=${did}`, {
		signal: with_timeout(signal, REPO_TIMEOUT),
	});
	const body = response.body;

	if (!response.ok || !body) {
		throw new Error(`Failed to retrieve the repository, response error ${response.status}`);
	}

	const chunks: Uint8Array[] = [];

	let size = 0;

	for await (const chunk of iterate_stream(body)) {
		size += chunk.length;
		chunks.push(chunk);

		progress.update(`Downloading repository (${format_bytes(size)})`);
	}

	const bytes = new Uint8Array(size);
	let offset = 0;

	for (let i = 0, il = chunks.length; i < il; i++) {
		const chunk = chunks[i];

		bytes.set(chunk, offset);
		offset += chunk.length;
	}

	logger.log(`Downloaded repository (${format_bytes(size)})`);

	return bytes;
}

export async function read_repo_records(car_buf: Uint8Array, did: DID): Promise<RecordMap> {
	const car = await CarBlockIterator.fromBytes(car_buf);

	const roots = await car.getRoots();
	assert(roots.length === 1, `expected 1 root commit`);

	const root_cid = roots[0];
	const blockmap: BlockMap = new Map();

	for await (const { cid, bytes } of car) {
		blockmap.set(cid.toString(), bytes);
	}

	const commit = read_obj(blockmap, root_cid) as Commit;
	assert(commit.did === did, `repository belongs to ${commit.did}, expected ${did}`);

	const records: RecordMap = new Map();

	for (const { key, cid } of walk_entries(blockmap, commit.data)) {
		const [collection] = key.split('/');

		if (ARCHIVED_COLLECTIONS.has(collection)) {
			records.set(key, read_obj(blockmap, cid));
		}
	}

	return records;
}

export async function load_stored_records(path: string): Promise<RecordMap> {
	let bytes: Uint8Array;

	try {
		bytes = await readFile(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return new Map();
		}

		throw err;
	}

	return new Map(Object.entries(decode_cbor(bytes) as Record<string, unknown>));
}

export async function save_stored_records(path: string, records: RecordMap) {
	await write_file_atomic(path, encode_cbor(Object.fromEntries(records)));
}

type BlockMap = Map<string, Uint8Array>;

interface Commit {
	version: 3;
	did: string;
	data: CID;
	rev: string;
	prev: CID | null;
	sig: Uint8Array;
}

interface TreeEntry {
	/** count of bytes shared with previous TreeEntry in this Node (if any) */
	p: number;
	/** remainder of key for this TreeEntry, after "prefixlen" have been removed */
	k: Uint8Array;
	/** link to a sub-tree Node at a lower level which has keys sorting after this TreeEntry's key (to the "right"), but before the next TreeEntry's key in this Node (if any) */
	v: CID;
	/** next subtree (to the right of leaf) */
	t: CID | null;
}

interface MstNode {
	/** link to sub-tree Node on a lower level and with all keys sorting before keys at this node */
	l: CID | null;
	/** ordered list of TreeEntry objects */
	e: TreeEntry[];
}

interface NodeEntry {
	key: string;
	cid: CID;
}

function* walk_entries(map: BlockMap, pointer: CID): Generator<NodeEntry> {
	const data = read_obj(map, pointer) as MstNode;
	const entries = data.e;

	let last_key = '';

	if (data.l !== null) {
		yield* walk_entries(map, data.l);
	}

	for (let i = 0, il = entries.length; i < il; i++) {
		const entry = entries[i];

		const key_str = decoder.decode(entry.k);
		const key = last_key.slice(0, entry.p) + key_str;

		last_key = key;

		yield { key: key, cid: entry.v };

		if (entry.t !== null) {
			yield* walk_entries(map, entry.t);
		}
	}
}

function read_obj(map: BlockMap, cid: CID) {
	const bytes = map.get(cid.toString());
	assert(bytes != null, `cid not found`);

	const data = decode_cbor(bytes);

	return data;
}
