export async function* iterate_stream<T>(stream: ReadableStream<T>) {
	// Get a lock on the stream
	const reader = stream.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				return;
			}

			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function with_timeout(signal: AbortSignal, ms: number) {
	return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}
