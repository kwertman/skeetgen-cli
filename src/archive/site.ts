import { join } from 'node:path';

import type { DidDocument } from '@mary/bluesky-client';
import type {
	AppBskyActorProfile,
	AppBskyFeedGenerator,
	AppBskyFeedPost,
	AppBskyFeedThreadgate,
	AppBskyGraphList,
	At,
} from '@mary/bluesky-client/lexicons';

import style_css from '../../gen/style.css?raw';
import search_js from '../../gen/search.js?raw';

import { get_blob_str, render_page, type BaseContext } from '../templates/context.ts';
import { chunked } from '../templates/utils/misc.ts';
import { create_posts_graph } from '../templates/utils/posts.ts';
import { get_tid_segment } from '../templates/utils/url.ts';

import { SearchPage } from '../templates/pages/SearchPage.tsx';
import { ThreadPage } from '../templates/pages/ThreadPage.tsx';
import { TimelinePage } from '../templates/pages/TimelinePage.tsx';
import { WelcomePage } from '../templates/pages/WelcomePage.tsx';

import { write_file_atomic } from '../utils/fs.ts';
import type { Logger } from '../utils/logger.ts';

import { load_image_descriptions } from './descriptions.ts';
import type { RecordMap } from './repository.ts';

export async function render_site(
	signal: AbortSignal,
	logger: Logger,
	out_dir: string,
	did: DidDocument,
	records: RecordMap,
) {
	let profile: AppBskyActorProfile.Record | undefined;

	const feeds = new Map<string, AppBskyFeedGenerator.Record>();
	const lists = new Map<string, AppBskyGraphList.Record>();
	const posts = new Map<string, AppBskyFeedPost.Record>();
	const threadgates = new Map<string, AppBskyFeedThreadgate.Record>();

	for (const [key, record] of records) {
		const [collection, rkey] = key.split('/');

		if (collection === 'app.bsky.feed.post') {
			posts.set(rkey, record as AppBskyFeedPost.Record);
		} else if (collection === 'app.bsky.actor.profile') {
			profile = record as AppBskyActorProfile.Record;
		} else if (collection === 'app.bsky.feed.generator') {
			feeds.set(rkey, record as AppBskyFeedGenerator.Record);
		} else if (collection === 'app.bsky.graph.list') {
			lists.set(rkey, record as AppBskyGraphList.Record);
		} else if (collection === 'app.bsky.feed.threadgate') {
			threadgates.set(rkey, record as AppBskyFeedThreadgate.Record);
		}
	}

	let base_context: BaseContext;

	// Set up the necessary context for rendering pages
	{
		const handles = did.alsoKnownAs?.filter((uri) => uri.startsWith('at://')).map((uri) => uri.slice(5));

		base_context = {
			posts_dir: '/posts',
			blob_dir: `/blobs`,
			asset_dir: `/assets`,

			records: {
				feeds: feeds,
				lists: lists,
				posts: posts,
				threadgates: threadgates,
			},
			post_graph: create_posts_graph(did.id as At.DID, posts),
			image_descriptions: await load_image_descriptions(out_dir),

			profile: {
				did: did.id as At.DID,
				handle: handles && handles.length > 0 ? handles[0] : 'handle.invalid',
				displayName: profile?.displayName?.trim(),
				avatar: profile?.avatar && get_blob_str(profile?.avatar),
			},
		};
	}

	const write_page = (path: string, render: Parameters<typeof render_page>[0]['render']) => {
		const html = render_page({
			context: {
				...base_context,
				path: `/${path}`,
			},
			render: render,
		});

		return write_file_atomic(join(out_dir, path), html);
	};

	// Render individual threads
	{
		signal.throwIfAborted();
		using _progress = logger.progress(`Rendering threads`);

		for (const [rkey, post] of posts) {
			signal.throwIfAborted();

			await write_page(`posts/${get_tid_segment(rkey)}.html`, () => {
				return ThreadPage({ post: post, rkey: rkey });
			});
		}
	}

	// Render timelines
	{
		signal.throwIfAborted();
		using _progress = logger.progress(`Rendering timelines`);

		const post_tuples = [...posts];

		// We want the posts to be sorted by newest-first
		{
			const collator = new Intl.Collator('en-US');
			post_tuples.sort((a, b) => collator.compare(b[0], a[0]));
		}

		// All posts
		{
			await write_timeline_pages('with_replies', post_tuples);
		}

		// Root posts only
		{
			const root_posts = post_tuples.filter(([, post]) => post.reply === undefined);
			await write_timeline_pages('posts', root_posts);
		}

		// Image posts only
		{
			const media_posts = post_tuples.filter(([, post]) => {
				const embed = post.embed;

				return (
					embed !== undefined &&
					(embed.$type === 'app.bsky.embed.images' ||
						(embed.$type === 'app.bsky.embed.recordWithMedia' &&
							embed.media.$type === 'app.bsky.embed.images'))
				);
			});

			await write_timeline_pages('media', media_posts);
		}
	}

	// Render remaining pages
	{
		signal.throwIfAborted();

		await write_page(`search.html`, () => SearchPage({}));
		await write_page(`index.html`, () => WelcomePage({}));
	}

	// Copy the necessary assets
	{
		await write_file_atomic(join(out_dir, 'assets/style.css'), style_css);
		await write_file_atomic(join(out_dir, 'assets/search.js'), search_js);
	}

	return posts.size;

	async function write_timeline_pages(
		type: 'posts' | 'with_replies' | 'media',
		tuples: [rkey: string, post: AppBskyFeedPost.Record][],
	) {
		const pages = chunked(tuples, 50);

		// Push an empty page
		if (pages.length === 0) {
			pages.push([]);
		}

		for (let i = 0, ilen = pages.length; i < ilen; i++) {
			const page = pages[i];

			await write_page(`timeline/${type}/${i + 1}.html`, () => {
				return TimelinePage({
					type: type,
					current_page: i + 1,
					total_pages: ilen,
					posts: page,
				});
			});
		}
	}
}
