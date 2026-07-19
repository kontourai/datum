import { Buffer } from "node:buffer";

export interface BoundedJsonOptions {
  label: string;
  maxBytes: number;
  maxDepth: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxStringBytes: number;
  fail(message: string): never;
  limit(message: string): never;
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Clone plain JSON data while enforcing limits before any full serialization. */
export function cloneBoundedJson(value: unknown, options: BoundedJsonOptions): unknown {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > options.maxBytes) options.limit(`${options.label} exceeds ${options.maxBytes} bytes.`);
  };
  const clone = (input: unknown, path: string, depth: number): unknown => {
    if (depth > options.maxDepth) options.limit(`${options.label} exceeds maximum nesting depth ${options.maxDepth} at ${path}.`);
    if (input === null) { charge(4); return null; }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) options.fail(`${options.label} contains a non-finite number at ${path}.`);
      charge(String(input).length);
      return input;
    }
    if (typeof input === "string") {
      const length = Buffer.byteLength(input, "utf8");
      if (length > options.maxStringBytes) options.limit(`${options.label} string at ${path} exceeds ${options.maxStringBytes} bytes.`);
      charge(jsonStringBytes(input));
      return input;
    }
    if (typeof input !== "object") options.fail(`${options.label} contains non-JSON data at ${path}.`);
    if (seen.has(input)) options.fail(`${options.label} contains a cycle at ${path}.`);
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) options.fail(`${options.label} contains a non-plain array at ${path}.`);
        if (input.length > options.maxArrayLength) options.limit(`${options.label} array at ${path} exceeds ${options.maxArrayLength} entries.`);
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
          options.fail(`${options.label} array at ${path} contains unsupported properties.`);
        }
        charge(2 + Math.max(0, input.length - 1));
        return Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
            options.fail(`${options.label} array at ${path} must be dense plain data.`);
          }
          return clone(descriptor.value, `${path}[${index}]`, depth + 1);
        });
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) options.fail(`${options.label} contains a non-plain object at ${path}.`);
      const keys = Reflect.ownKeys(input);
      if (keys.length > options.maxObjectKeys) options.limit(`${options.label} object at ${path} exceeds ${options.maxObjectKeys} fields.`);
      const output: Record<string, unknown> = {};
      charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== "string") options.fail(`${options.label} object at ${path} contains a symbol key.`);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          options.fail(`${options.label} object at ${path} must contain enumerable data properties only.`);
        }
        charge(jsonStringBytes(key) + 1);
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return output;
    } finally {
      seen.delete(input);
    }
  };
  return clone(value, "$", 0);
}
