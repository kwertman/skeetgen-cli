import { BskyXRPC, type DidDocument } from '@mary/bluesky-client';

import type { Logger } from '../utils/logger.ts';
import { with_timeout } from '../utils/misc.ts';

export type DID = `did:${string}`;

const APPVIEW_URL = 'https://public.api.bsky.app';
const HOST_RE = /^([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*(?:\.[a-zA-Z]+))$/;

const REQUEST_TIMEOUT = 30_000;

const is_did = (str: string): str is DID => {
	return str.startsWith('did:');
};

export async function resolve_did(signal: AbortSignal, logger: Logger, identifier: string): Promise<DID> {
	if (is_did(identifier)) {
		return identifier;
	}

	using _progress = logger.progress(`Resolving ${identifier}`);

	const rpc = new BskyXRPC({ service: APPVIEW_URL });

	const response = await rpc.get('com.atproto.identity.resolveHandle', {
		signal: with_timeout(signal, REQUEST_TIMEOUT),
		params: {
			handle: identifier,
		},
	});

	const did = response.data.did;
	logger.log(`Resolved @${identifier} to ${did}`);

	return did;
}

export async function retrieve_did_document(
	signal: AbortSignal,
	logger: Logger,
	did: DID,
): Promise<DidDocument> {
	const [, type, ...rest] = did.split(':');
	const ident = rest.join(':');

	if (type === 'plc') {
		using _progress = logger.progress(`Contacting PLC directory`);

		const response = await fetch(`https://plc.directory/${did}`, {
			signal: with_timeout(signal, REQUEST_TIMEOUT),
		});

		if (response.status === 404) {
			throw new Error(`DID not registered`);
		} else if (!response.ok) {
			throw new Error(`Unable to contact PLC directory, response error ${response.status}`);
		}

		return (await response.json()) as DidDocument;
	} else if (type === 'web') {
		if (!HOST_RE.test(ident)) {
			throw new Error(`Invalid did:web identifier: ${ident}`);
		}

		using _progress = logger.progress(`Contacting ${ident}`);

		const response = await fetch(`https://${ident}/.well-known/did.json`, {
			signal: with_timeout(signal, REQUEST_TIMEOUT),
		});

		if (response.status === 404) {
			throw new Error(`DID document not found`);
		} else if (!response.ok) {
			throw new Error(`Unable to retrieve DID document, response error ${response.status}`);
		}

		return (await response.json()) as DidDocument;
	}

	throw new Error(`Unsupported DID type: ${type}`);
}
