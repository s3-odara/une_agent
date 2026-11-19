import { writeWav } from "./tts.ts";

/** Made here so there is no sound file to ship or license. */
export function chimeWav(sampleRate: number): Buffer {
	const notes = [
		{ hz: 1046.5, ms: 70 },
		{ hz: 1568, ms: 130 },
	];
	const lengths = notes.map(({ ms }) => Math.round((sampleRate * ms) / 1000));
	const samples = new Int16Array(lengths.reduce((a, b) => a + b, 0));
	const attack = Math.round(sampleRate * 0.005);
	let offset = 0;
	for (const [n, { hz }] of notes.entries()) {
		const length = lengths[n]!;
		for (let i = 0; i < length; i++) {
			// A tone that starts or stops abruptly clicks.
			const envelope = Math.min(1, i / attack) * Math.exp((-4 * i) / length) * Math.min(1, (length - i) / attack);
			samples[offset + i] = Math.round(0.25 * envelope * Math.sin((2 * Math.PI * hz * i) / sampleRate) * 32767);
		}
		offset += length;
	}
	return writeWav(samples, sampleRate);
}
