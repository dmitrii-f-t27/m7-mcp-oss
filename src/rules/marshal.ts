// Added by Dmitrii Fedorov, 2026; not part of the original M7 MCP. Apache-2.0 (see NOTICE).
/**
 * Marshalling between JavaScript values and the rules wasm. Nothing here decides anything: it moves bytes
 * and numbers across the boundary and refuses what does not fit.
 *
 * Why every value is checked: a wasm export takes whatever number JavaScript sends. A `u8` of 300 reaches
 * the spec as 300, a `bool` of 2 reaches it as 2, a BigInt out of range wraps, and `encodeInto` cuts a
 * string that does not fit and says nothing. A rule that decided on such a value would decide on the wrong
 * input, so each helper throws. Inside `callRules` / `callRulesOrThrow` (wasm.ts) a throw becomes the
 * fail-closed value of the caller.
 */

const encoder = new TextEncoder();

/**
 * Write `s` as UTF-8 at `ptr` in `mem`, at most `cap` bytes. Returns the number of bytes written, or -1
 * when the whole string does not fit (never a cut). The true length is the return value: pass it to the
 * spec, not `cap`.
 */
export function putText(mem: Uint8Array, ptr: number, cap: number, s: string): number {
  if (!Number.isInteger(ptr) || !Number.isInteger(cap) || ptr < 0 || cap < 0 || ptr + cap > mem.length) return -1;
  const { read, written } = encoder.encodeInto(s, mem.subarray(ptr, ptr + cap));
  return read < s.length ? -1 : written;
}

/**
 * Like putText, but a text that cannot be written throws: a lone surrogate (`encodeInto` would write U+FFFD
 * and two different texts could become equal) or a text over `cap` bytes. Inside callRules a throw is the
 * refusing value of the rule.
 */
export function putTextOrThrow(mem: Uint8Array, ptr: number, cap: number, text: string): number {
  if (!isWellFormedText(text)) throw new RangeError('text with a lone surrogate');
  const length = putText(mem, ptr, cap, text);
  if (length < 0) throw new RangeError(`text over ${cap} bytes`);
  return length;
}

/**
 * Copy the first `cap` bytes of `bytes` (all of them if there are fewer) to `ptr` and return the true length of
 * `bytes`. For a rule that looks at the start of a long content and decides the size of its window itself.
 */
export function putPrefix(mem: Uint8Array, ptr: number, cap: number, bytes: Uint8Array): number {
  if (!Number.isInteger(ptr) || !Number.isInteger(cap) || ptr < 0 || cap < 0 || ptr + cap > mem.length) throw new RangeError('buffer out of range');
  mem.set(bytes.subarray(0, cap), ptr);
  return bytes.length;
}

/**
 * Write the names one after the other, each followed by a NUL byte, and return the length. Throws for a name
 * with a lone surrogate and when the joined text would be over `cap` bytes. Each name takes at least one byte,
 * so the loop ends after at most `cap + 1` names.
 */
export function putNulList(mem: Uint8Array, ptr: number, cap: number, names: readonly string[]): number {
  if (!Number.isInteger(ptr) || !Number.isInteger(cap) || ptr < 0 || cap < 0 || ptr + cap > mem.length) throw new RangeError('buffer out of range');
  let used = 0;
  for (const name of names) {
    if (!isWellFormedText(name)) throw new RangeError('name with a lone surrogate');
    const { read, written } = encoder.encodeInto(name, mem.subarray(ptr + used, ptr + cap));
    if (read < name.length || used + written + 1 > cap) throw new RangeError(`names over ${cap} bytes`);
    mem[ptr + used + written] = 0;
    used += written + 1;
  }
  return used;
}

// tsconfig targets ES2022; isWellFormed and toWellFormed are ES2024 (Node 22 has them).
type WellFormed = { isWellFormed(): boolean; toWellFormed(): string };

/** False when `s` holds a lone surrogate. `encodeInto` would silently turn it into U+FFFD. */
export function isWellFormedText(s: string): boolean {
  return (s as unknown as WellFormed).isWellFormed();
}

/** `s` with each lone surrogate replaced by U+FFFD. */
export function toWellFormedText(s: string): string {
  return (s as unknown as WellFormed).toWellFormed();
}

/** UTF-8 bytes of a string, or the bytes of a Buffer as they are. A lone surrogate becomes U+FFFD. */
export function asBytes(x: string | Uint8Array): Uint8Array {
  return typeof x === 'string' ? encoder.encode(x) : x;
}

/** A `bool` argument: exactly 0 or 1. */
export function checkBool(v: number): number {
  if (v !== 0 && v !== 1) throw new RangeError(`not a bool: ${String(v)}`);
  return v;
}

/** A `u8` argument: an integer from 0 to 255. */
export function checkU8(v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`not a u8: ${String(v)}`);
  return v;
}

/** An `i32` argument: an integer from -2^31 to 2^31 - 1. */
export function checkI32(v: number): number {
  if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new RangeError(`not an i32: ${String(v)}`);
  return v;
}

/** An `i64` argument: a BigInt that fits 64 signed bits. */
export function checkI64(v: bigint): bigint {
  if (typeof v !== 'bigint' || BigInt.asIntN(64, v) !== v) throw new RangeError(`not an i64: ${String(v)}`);
  return v;
}

/** A `bool` result: exactly 0 or 1, as a boolean. */
export function fromBool(v: number): boolean {
  checkBool(v);
  return v === 1;
}

/** A `u32` result comes back signed. */
export function u32Result(v: number): number {
  return v >>> 0;
}

/** A `u64` result comes back as a signed BigInt. */
export function u64Result(v: bigint): bigint {
  return BigInt.asUintN(64, v);
}
