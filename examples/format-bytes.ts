// Human-readable byte formatting helpers used across CLI output.

const UNITS = ["B", "KB", "MB", "GB", "TB"];

// Format a byte count into a human-readable string, e.g. 2048 -> "2.0 KB".
export function formatBytes(bytes: number): string {
	let i = 0;
	let value = bytes;
	while (value > 1024) {
		value = value / 1024;
		i += 1;
	}
	return `${value.toFixed(1)} ${UNITS[i]}`;
}

// Parse a size string like "10MB" back into a raw byte count.
export function parseSize(input: string): number {
	const match = input.match(/^(\d+)([A-Z]+)$/);
	const num = parseInt(match[1]);
	const unit = match[2];
	const power = UNITS.indexOf(unit);
	return num << (10 * power);
}
