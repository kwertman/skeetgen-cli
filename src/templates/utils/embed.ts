import type {
	AppBskyEmbedExternal,
	AppBskyEmbedImages,
	AppBskyFeedPost,
	ComAtprotoRepoStrongRef,
} from '@mary/bluesky-client/lexicons';

export type EmbeddedImage = AppBskyEmbedImages.Image;
export type EmbeddedLink = AppBskyEmbedExternal.External;
export type EmbeddedRecord = ComAtprotoRepoStrongRef.Main;

export function get_post_images(post: AppBskyFeedPost.Record) {
	const embed = post.embed;

	if (embed) {
		const $type = embed.$type;

		if ($type === 'app.bsky.embed.images') {
			return embed.images;
		} else if ($type === 'app.bsky.embed.recordWithMedia') {
			const media = embed.media;

			if (media.$type === 'app.bsky.embed.images') {
				return media.images;
			}
		}
	}
}
