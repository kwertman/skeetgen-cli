import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Writes through a temporary file, so that an interrupted run never leaves a partial file behind. */
export async function write_file_atomic(path: string, data: string | Uint8Array) {
	const tmp_path = `${path}.${process.pid}.tmp`;

	await mkdir(dirname(path), { recursive: true });

	try {
		await writeFile(tmp_path, data);
		await rename(tmp_path, path);
	} catch (err) {
		await rm(tmp_path, { force: true });
		throw err;
	}
}
