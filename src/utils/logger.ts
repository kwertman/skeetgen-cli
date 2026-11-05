const CLEAR_LINE = '\r\x1b[K';

const is_tty = process.stderr.isTTY;

// Swedish locale formats as `YYYY-MM-DD HH:mm:ss`, which reads well in log files
const get_timestamp = () => new Date().toLocaleString('sv');

export class Logger {
	log(message: string) {
		this.write(`${get_timestamp()} ${message}`);
	}

	warn(message: string) {
		this.write(`${get_timestamp()} warning: ${message}`);
	}

	error(message: string) {
		this.write(`${get_timestamp()} error: ${message}`);
	}

	progress(message: string = '') {
		return new ProgressLogger(message);
	}

	private write(line: string) {
		process.stderr.write((is_tty ? CLEAR_LINE : '') + line + '\n');
	}
}

class ProgressLogger {
	private _ratelimited = false;

	constructor(message: string) {
		this.show(message);
	}

	update(message: string) {
		if (!this._ratelimited) {
			this._ratelimited = true;
			this.show(message);

			setTimeout(() => {
				this._ratelimited = false;
			}, 250);
		}
	}

	destroy() {
		if (is_tty) {
			process.stderr.write(CLEAR_LINE);
		}
	}

	// Progress is only useful to someone watching, it'd be noise in a log file.
	private show(message: string) {
		if (is_tty) {
			process.stderr.write(CLEAR_LINE + message);
		}
	}

	[Symbol.dispose]() {
		return this.destroy();
	}
}
