/**
 * SafeObject — own-property helpers for dynamic keys.
 *
 * Accumulators, deep merges and parsers keyed by caller-supplied or parsed
 * strings must never reach the `Object.prototype` setter (a `__proto__` key
 * would otherwise pollute every object in the process) and must never read
 * through the prototype chain (a `constructor` key would otherwise return an
 * inherited function instead of `undefined`). Use these helpers whenever the
 * key is not a literal.
 */

/** True when `key` is an own property of `object`; inherited names return false. */
export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Read an own property only; inherited names such as `constructor` yield undefined. */
export function ownGet<T>(object: Record<string, T>, key: string): T | undefined {
  return hasOwn(object, key) ? object[key] : undefined;
}

/** Define an own enumerable data property so a `__proto__` key cannot walk the prototype. */
export function assignOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
