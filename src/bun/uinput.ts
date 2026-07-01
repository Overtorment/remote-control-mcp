import { dlopen, FFIType, ptr } from "bun:ffi";
import { accessSync, constants } from "node:fs";

const UINPUT_PATH = "/dev/uinput";

// True if the current process can write to /dev/uinput (i.e. create devices).
export function uinputWritable(): boolean {
	try {
		accessSync(UINPUT_PATH, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export type EnsureAccessResult = {
	ok: boolean;
	changed: boolean;
	error?: string;
};

// If /dev/uinput isn't writable, ask for elevation via pkexec (graphical
// password dialog) and chmod it so the running process can create devices.
// Note: this is a session-only fix and does not survive a reboot.
export async function ensureUinputAccess(): Promise<EnsureAccessResult> {
	if (uinputWritable()) {
		return { ok: true, changed: false };
	}

	const pkexec = Bun.which("pkexec");
	if (!pkexec) {
		return {
			ok: false,
			changed: false,
			error: `pkexec not found. Run manually: sudo chmod 666 ${UINPUT_PATH}`,
		};
	}

	try {
		const proc = Bun.spawn([pkexec, "chmod", "666", UINPUT_PATH], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;

		if (code === 126 || code === 127) {
			return {
				ok: uinputWritable(),
				changed: false,
				error: "Authorization was dismissed or failed.",
			};
		}
		if (code !== 0) {
			const stderr = (await new Response(proc.stderr).text()).trim();
			return {
				ok: uinputWritable(),
				changed: false,
				error: stderr || `pkexec exited with code ${code}`,
			};
		}
	} catch (error) {
		return { ok: false, changed: false, error: (error as Error).message };
	}

	return { ok: uinputWritable(), changed: true };
}

// Minimal Linux uinput bindings to create a virtual absolute-positioning mouse.
// This lets the app synthesize clicks at specific screen coordinates on both
// X11 and Wayland (the compositor sees a real kernel input device).

const libc = dlopen("libc.so.6", {
	open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	ioctl: {
		args: [FFIType.i32, FFIType.u64, FFIType.u64],
		returns: FFIType.i32,
	},
	write: {
		args: [FFIType.i32, FFIType.ptr, FFIType.u64],
		returns: FFIType.i64,
	},
	close: { args: [FFIType.i32], returns: FFIType.i32 },
});

// ioctl request-code encoding (asm-generic, valid on x86_64/arm64).
const _IOC = (dir: number, type: number, nr: number, size: number) =>
	((dir << 30) | (size << 16) | (type << 8) | nr) >>> 0;
const _IO = (type: number, nr: number) => _IOC(0, type, nr, 0);
const _IOW = (type: number, nr: number, size: number) =>
	_IOC(1, type, nr, size);

const UINPUT = 0x55; // 'U'
const UI_SET_EVBIT = _IOW(UINPUT, 100, 4);
const UI_SET_KEYBIT = _IOW(UINPUT, 101, 4);
const UI_SET_ABSBIT = _IOW(UINPUT, 103, 4);
const UI_DEV_CREATE = _IO(UINPUT, 1);
const UI_DEV_DESTROY = _IO(UINPUT, 2);

// Event types / codes (from linux/input-event-codes.h).
const EV_SYN = 0;
const EV_KEY = 1;
const EV_ABS = 3;
const SYN_REPORT = 0;
const ABS_X = 0;
const ABS_Y = 1;

const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const BTN_MIDDLE = 0x112;

const O_WRONLY = 1;
const O_NONBLOCK = 0o4000;

export type MouseButton = "left" | "right" | "middle";

const BUTTON_CODES: Record<MouseButton, number> = {
	left: BTN_LEFT,
	right: BTN_RIGHT,
	middle: BTN_MIDDLE,
};

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// struct input_event is 24 bytes on 64-bit:
//   struct timeval time (16) | __u16 type | __u16 code | __s32 value
function inputEvent(type: number, code: number, value: number): ArrayBuffer {
	const buf = new ArrayBuffer(24);
	const dv = new DataView(buf);
	dv.setUint16(16, type, true);
	dv.setUint16(18, code, true);
	dv.setInt32(20, value, true);
	return buf;
}

export class VirtualMouse {
	private fd = -1;
	private width: number;
	private height: number;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}

	get isOpen() {
		return this.fd >= 0;
	}

	get resolution() {
		return { width: this.width, height: this.height };
	}

	setResolution(width: number, height: number) {
		// Changing the abs range requires recreating the device.
		if (width === this.width && height === this.height) return;
		this.width = width;
		this.height = height;
		if (this.isOpen) {
			this.destroy();
		}
	}

	private ioctlOrThrow(request: number, arg: number, label: string) {
		const ret = libc.symbols.ioctl(this.fd, BigInt(request), BigInt(arg));
		if (ret < 0) {
			throw new Error(`uinput ioctl ${label} failed (ret=${ret})`);
		}
	}

	async create() {
		if (this.isOpen) return;

		const pathBuf = Buffer.from("/dev/uinput\0", "utf8");
		const fd = libc.symbols.open(ptr(pathBuf), O_WRONLY | O_NONBLOCK);
		if (fd < 0) {
			throw new Error(
				"Cannot open /dev/uinput. It is likely root-only; grant write access (see setup notes).",
			);
		}
		this.fd = fd;

		try {
			this.ioctlOrThrow(UI_SET_EVBIT, EV_KEY, "SET_EVBIT EV_KEY");
			this.ioctlOrThrow(UI_SET_KEYBIT, BTN_LEFT, "SET_KEYBIT BTN_LEFT");
			this.ioctlOrThrow(UI_SET_KEYBIT, BTN_RIGHT, "SET_KEYBIT BTN_RIGHT");
			this.ioctlOrThrow(UI_SET_KEYBIT, BTN_MIDDLE, "SET_KEYBIT BTN_MIDDLE");
			this.ioctlOrThrow(UI_SET_EVBIT, EV_ABS, "SET_EVBIT EV_ABS");
			this.ioctlOrThrow(UI_SET_ABSBIT, ABS_X, "SET_ABSBIT ABS_X");
			this.ioctlOrThrow(UI_SET_ABSBIT, ABS_Y, "SET_ABSBIT ABS_Y");

			this.writeUserDev();
			this.ioctlOrThrow(UI_DEV_CREATE, 0, "DEV_CREATE");
		} catch (err) {
			this.destroy();
			throw err;
		}

		// Give the compositor a moment to register the new device.
		await sleep(300);
	}

	// Legacy device setup: write a struct uinput_user_dev, then UI_DEV_CREATE.
	// Layout (1116 bytes on 64-bit):
	//   name[80] | input_id(8) | ff_effects_max(4) |
	//   absmax[64] | absmin[64] | absfuzz[64] | absflat[64]   (each s32)
	private writeUserDev() {
		const ABS_CNT = 64;
		const size = 80 + 8 + 4 + ABS_CNT * 4 * 4;
		const buf = new ArrayBuffer(size);
		const dv = new DataView(buf);
		const bytes = new Uint8Array(buf);

		const name = Buffer.from("electrobun-virtual-mouse", "utf8");
		bytes.set(name.subarray(0, 79), 0);

		// struct input_id { u16 bustype, vendor, product, version }
		const BUS_USB = 0x03;
		dv.setUint16(80, BUS_USB, true);
		dv.setUint16(82, 0x1234, true);
		dv.setUint16(84, 0x5678, true);
		dv.setUint16(86, 0x0001, true);

		// ff_effects_max at offset 88 stays 0.
		const absmaxOffset = 92;
		dv.setInt32(absmaxOffset + ABS_X * 4, Math.max(0, this.width - 1), true);
		dv.setInt32(absmaxOffset + ABS_Y * 4, Math.max(0, this.height - 1), true);
		// absmin/absfuzz/absflat remain 0.

		const written = libc.symbols.write(this.fd, ptr(bytes), BigInt(size));
		if (Number(written) !== size) {
			throw new Error(
				`Failed to write uinput_user_dev (wrote ${written}/${size})`,
			);
		}
	}

	private emit(type: number, code: number, value: number) {
		const ev = inputEvent(type, code, value);
		const written = libc.symbols.write(this.fd, ptr(ev), 24n);
		if (Number(written) !== 24) {
			throw new Error(`Failed to write input_event (wrote ${written}/24)`);
		}
	}

	private syn() {
		this.emit(EV_SYN, SYN_REPORT, 0);
	}

	private clamp(value: number, max: number) {
		if (value < 0) return 0;
		if (value > max) return max;
		return Math.round(value);
	}

	private emitAbs(x: number, y: number) {
		this.emit(EV_ABS, ABS_X, x);
		this.emit(EV_ABS, ABS_Y, y);
		this.syn();
	}

	// Move the absolute pointer to (x, y) reliably.
	//
	// The kernel caches the device's last-reported ABS_X/ABS_Y and drops events
	// whose value is unchanged. After the *physical* mouse moves the cursor, this
	// device's cached position goes stale: re-emitting the same coordinate emits
	// nothing, so the cursor never moves and a following click lands at the wrong
	// place. To defeat this, we first nudge to a guaranteed-different position,
	// then emit the exact target — forcing a real delta every time.
	private async moveAbsolute(x: number, y: number) {
		const tx = this.clamp(x, this.width - 1);
		const ty = this.clamp(y, this.height - 1);
		const nx = tx > 0 ? tx - 1 : tx + 1;
		const ny = ty > 0 ? ty - 1 : ty + 1;

		this.emitAbs(nx, ny);
		await sleep(5);
		this.emitAbs(tx, ty);
	}

	async moveTo(x: number, y: number) {
		await this.create();
		await this.moveAbsolute(x, y);
	}

	async click(x: number, y: number, button: MouseButton = "left") {
		await this.create();
		const code = BUTTON_CODES[button];

		await this.moveAbsolute(x, y);
		// Let the compositor actually reposition the cursor before pressing.
		await sleep(40);

		this.emit(EV_KEY, code, 1);
		this.syn();
		await sleep(40);

		this.emit(EV_KEY, code, 0);
		this.syn();
	}

	destroy() {
		if (this.fd < 0) return;
		try {
			libc.symbols.ioctl(this.fd, BigInt(UI_DEV_DESTROY), 0n);
		} catch {
			// ignore
		}
		libc.symbols.close(this.fd);
		this.fd = -1;
	}
}

// ---------------------------------------------------------------------------
// Virtual keyboard
// ---------------------------------------------------------------------------
// NOTE: uinput emits physical keycodes, not characters. The compositor maps
// keycodes -> characters using the ACTIVE XKB layout. The maps below assume a
// US QWERTY layout. Non-US layouts (e.g. RU) or non-ASCII characters will not
// type correctly via raw keycodes.

// Linux keycodes for letters (from input-event-codes.h).
const LETTER_CODES: Record<string, number> = {
	a: 30,
	b: 48,
	c: 46,
	d: 32,
	e: 18,
	f: 33,
	g: 34,
	h: 35,
	i: 23,
	j: 36,
	k: 37,
	l: 38,
	m: 50,
	n: 49,
	o: 24,
	p: 25,
	q: 16,
	r: 19,
	s: 31,
	t: 20,
	u: 22,
	v: 47,
	w: 17,
	x: 45,
	y: 21,
	z: 44,
};

// [unshifted char, shifted char, keycode] for the number row + symbols (US).
const SYMBOL_ROWS: Array<[string, string, number]> = [
	["1", "!", 2],
	["2", "@", 3],
	["3", "#", 4],
	["4", "$", 5],
	["5", "%", 6],
	["6", "^", 7],
	["7", "&", 8],
	["8", "*", 9],
	["9", "(", 10],
	["0", ")", 11],
	["-", "_", 12],
	["=", "+", 13],
	["[", "{", 26],
	["]", "}", 27],
	[";", ":", 39],
	["'", '"', 40],
	["`", "~", 41],
	["\\", "|", 43],
	[",", "<", 51],
	[".", ">", 52],
	["/", "?", 53],
];

type KeyMapEntry = { code: number; shift: boolean };

const CHAR_MAP: Record<string, KeyMapEntry> = (() => {
	const map: Record<string, KeyMapEntry> = {};
	for (const [letter, code] of Object.entries(LETTER_CODES)) {
		map[letter] = { code, shift: false };
		map[letter.toUpperCase()] = { code, shift: true };
	}
	for (const [plain, shifted, code] of SYMBOL_ROWS) {
		map[plain] = { code, shift: false };
		map[shifted] = { code, shift: true };
	}
	map[" "] = { code: 57, shift: false };
	map["\n"] = { code: 28, shift: false };
	map["\t"] = { code: 15, shift: false };
	return map;
})();

// Named keys for pressKey() (layout-independent for these).
const NAMED_KEYS: Record<string, number> = {
	enter: 28,
	return: 28,
	tab: 15,
	esc: 1,
	escape: 1,
	space: 57,
	backspace: 14,
	delete: 111,
	del: 111,
	up: 103,
	down: 108,
	left: 105,
	right: 106,
	home: 102,
	end: 107,
	pageup: 104,
	pagedown: 109,
	insert: 110,
	f1: 59,
	f2: 60,
	f3: 61,
	f4: 62,
	f5: 63,
	f6: 64,
	f7: 65,
	f8: 66,
	f9: 67,
	f10: 68,
	f11: 87,
	f12: 88,
};

const MODIFIER_KEYS: Record<string, number> = {
	ctrl: 29,
	control: 29,
	shift: 42,
	alt: 56,
	altgr: 100,
	meta: 125,
	super: 125,
	cmd: 125,
	win: 125,
};

const KEY_LEFTSHIFT = 42;

// Normally-distributed random value (Box-Muller) for natural-looking jitter.
function gaussian(mean: number, stdDev: number): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	return mean + n * stdDev;
}

// Human-like delay (ms) to wait after typing a given character.
function humanKeyDelay(char: string): number {
	// Base inter-keystroke interval (~110ms mean ≈ a brisk typist).
	let delay = gaussian(110, 35);

	// Longer pauses at word and sentence boundaries.
	if (char === " ") {
		delay += gaussian(60, 25);
	} else if (".,!?;:".includes(char)) {
		delay += gaussian(130, 45);
	} else if (char === "\n") {
		delay += gaussian(220, 70);
	}

	// Occasional "thinking" pause.
	if (Math.random() < 0.04) {
		delay += gaussian(320, 130);
	}

	return Math.max(30, Math.min(delay, 1200));
}

// All keycodes the device must advertise before UI_DEV_CREATE.
const KEYBOARD_KEYCODES: number[] = (() => {
	const set = new Set<number>();
	for (const { code } of Object.values(CHAR_MAP)) set.add(code);
	for (const code of Object.values(NAMED_KEYS)) set.add(code);
	for (const code of Object.values(MODIFIER_KEYS)) set.add(code);
	return [...set];
})();

export class VirtualKeyboard {
	private fd = -1;

	get isOpen() {
		return this.fd >= 0;
	}

	private ioctlOrThrow(request: number, arg: number, label: string) {
		const ret = libc.symbols.ioctl(this.fd, BigInt(request), BigInt(arg));
		if (ret < 0) {
			throw new Error(`uinput ioctl ${label} failed (ret=${ret})`);
		}
	}

	private emit(type: number, code: number, value: number) {
		const ev = inputEvent(type, code, value);
		const written = libc.symbols.write(this.fd, ptr(ev), 24n);
		if (Number(written) !== 24) {
			throw new Error(`Failed to write input_event (wrote ${written}/24)`);
		}
	}

	private syn() {
		this.emit(EV_SYN, SYN_REPORT, 0);
	}

	async create() {
		if (this.isOpen) return;

		const pathBuf = Buffer.from("/dev/uinput\0", "utf8");
		const fd = libc.symbols.open(ptr(pathBuf), O_WRONLY | O_NONBLOCK);
		if (fd < 0) {
			throw new Error(
				"Cannot open /dev/uinput. It is likely root-only; grant write access (see setup notes).",
			);
		}
		this.fd = fd;

		try {
			this.ioctlOrThrow(UI_SET_EVBIT, EV_KEY, "SET_EVBIT EV_KEY");
			for (const code of KEYBOARD_KEYCODES) {
				this.ioctlOrThrow(UI_SET_KEYBIT, code, `SET_KEYBIT ${code}`);
			}
			this.writeUserDev();
			this.ioctlOrThrow(UI_DEV_CREATE, 0, "DEV_CREATE");
		} catch (err) {
			this.destroy();
			throw err;
		}

		await sleep(300);
	}

	private writeUserDev() {
		const ABS_CNT = 64;
		const size = 80 + 8 + 4 + ABS_CNT * 4 * 4;
		const buf = new ArrayBuffer(size);
		const dv = new DataView(buf);
		const bytes = new Uint8Array(buf);

		const name = Buffer.from("electrobun-virtual-keyboard", "utf8");
		bytes.set(name.subarray(0, 79), 0);

		const BUS_USB = 0x03;
		dv.setUint16(80, BUS_USB, true);
		dv.setUint16(82, 0x1234, true);
		dv.setUint16(84, 0x5679, true);
		dv.setUint16(86, 0x0001, true);
		// No ABS axes for a keyboard; abs arrays stay zero.

		const written = libc.symbols.write(this.fd, ptr(bytes), BigInt(size));
		if (Number(written) !== size) {
			throw new Error(
				`Failed to write uinput_user_dev (wrote ${written}/${size})`,
			);
		}
	}

	private tapKey(code: number, shift: boolean) {
		if (shift) {
			this.emit(EV_KEY, KEY_LEFTSHIFT, 1);
			this.syn();
		}
		this.emit(EV_KEY, code, 1);
		this.syn();
		this.emit(EV_KEY, code, 0);
		this.syn();
		if (shift) {
			this.emit(EV_KEY, KEY_LEFTSHIFT, 0);
			this.syn();
		}
	}

	// Type a string with human-like randomized delays between keystrokes.
	// Returns characters that had no US-layout mapping.
	async typeText(text: string): Promise<{ skipped: string[] }> {
		await this.create();
		const skipped: string[] = [];
		const chars = [...text];

		for (const [i, char] of chars.entries()) {
			const entry = CHAR_MAP[char];
			if (!entry) {
				skipped.push(char);
				continue;
			}
			this.tapKey(entry.code, entry.shift);
			if (i < chars.length - 1) {
				await sleep(humanKeyDelay(char));
			}
		}

		return { skipped };
	}

	// Press a single key (named like "enter"/"f5" or a character) with optional
	// modifiers (e.g. ["ctrl"] for Ctrl+C).
	async pressKey(key: string, modifiers: string[] = []) {
		await this.create();

		const modCodes: number[] = [];
		for (const mod of modifiers) {
			const code = MODIFIER_KEYS[mod.toLowerCase()];
			if (code === undefined) {
				throw new Error(`Unknown modifier: ${mod}`);
			}
			modCodes.push(code);
		}

		let code: number;
		let shift = false;
		const named = NAMED_KEYS[key.toLowerCase()];
		if (named !== undefined) {
			code = named;
		} else if ([...key].length === 1 && CHAR_MAP[key]) {
			const entry = CHAR_MAP[key];
			code = entry.code;
			shift = entry.shift;
		} else {
			throw new Error(`Unknown key: ${key}`);
		}

		for (const mod of modCodes) {
			this.emit(EV_KEY, mod, 1);
			this.syn();
		}
		this.tapKey(code, shift);
		for (const mod of [...modCodes].reverse()) {
			this.emit(EV_KEY, mod, 0);
			this.syn();
		}
	}

	destroy() {
		if (this.fd < 0) return;
		try {
			libc.symbols.ioctl(this.fd, BigInt(UI_DEV_DESTROY), 0n);
		} catch {
			// ignore
		}
		libc.symbols.close(this.fd);
		this.fd = -1;
	}
}
