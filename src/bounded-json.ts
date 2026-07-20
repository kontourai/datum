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

interface CloneContext {
  options: BoundedJsonOptions;
  bytes: number;
  seen: WeakSet<object>;
}

function charge(context: CloneContext, amount: number): void {
  context.bytes += amount;
  if (context.bytes > context.options.maxBytes) context.options.limit(`${context.options.label} exceeds ${context.options.maxBytes} bytes.`);
}

function cloneScalar(input: null | boolean | number | string, path: string, context: CloneContext): unknown {
  const { options } = context;
  if (input === null) { charge(context, 4); return null; }
  if (typeof input === "boolean") { charge(context, input ? 4 : 5); return input; }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) options.fail(`${options.label} contains a non-finite number at ${path}.`);
    charge(context, String(input).length);
    return input;
  }
  const length = Buffer.byteLength(input, "utf8");
  if (length > options.maxStringBytes) options.limit(`${options.label} string at ${path} exceeds ${options.maxStringBytes} bytes.`);
  charge(context, jsonStringBytes(input));
  return input;
}

function dataDescriptor(input: object, key: string, path: string, context: CloneContext): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    const requirement = Array.isArray(input) ? "must be dense plain data" : "must contain enumerable data properties only";
    context.options.fail(`${context.options.label} ${Array.isArray(input) ? "array" : "object"} at ${path} ${requirement}.`);
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function cloneArray(input: unknown[], path: string, depth: number, context: CloneContext): unknown[] {
  const { options } = context;
  if (Object.getPrototypeOf(input) !== Array.prototype) options.fail(`${options.label} contains a non-plain array at ${path}.`);
  if (input.length > options.maxArrayLength) options.limit(`${options.label} array at ${path} exceeds ${options.maxArrayLength} entries.`);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) options.fail(`${options.label} array at ${path} contains unsupported properties.`);
  charge(context, 2 + Math.max(0, input.length - 1));
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = dataDescriptor(input, String(index), path, context);
    output.push(cloneValue(descriptor.value, `${path}[${index}]`, depth + 1, context));
  }
  return output;
}

function cloneObject(input: object, path: string, depth: number, context: CloneContext): Record<string, unknown> {
  const { options } = context;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) options.fail(`${options.label} contains a non-plain object at ${path}.`);
  const keys = Reflect.ownKeys(input);
  if (keys.length > options.maxObjectKeys) options.limit(`${options.label} object at ${path} exceeds ${options.maxObjectKeys} fields.`);
  const output: Record<string, unknown> = {};
  charge(context, 2 + Math.max(0, keys.length - 1));
  for (const key of keys) {
    if (typeof key !== "string") options.fail(`${options.label} object at ${path} contains a symbol key.`);
    const descriptor = dataDescriptor(input, key as string, path, context);
    charge(context, jsonStringBytes(key as string) + 1);
    Object.defineProperty(output, key, { value: cloneValue(descriptor.value, `${path}.${String(key)}`, depth + 1, context), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function cloneValue(input: unknown, path: string, depth: number, context: CloneContext): unknown {
  const { options } = context;
  if (depth > options.maxDepth) options.limit(`${options.label} exceeds maximum nesting depth ${options.maxDepth} at ${path}.`);
  if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") return cloneScalar(input, path, context);
  if (typeof input !== "object") return options.fail(`${options.label} contains non-JSON data at ${path}.`);
  if (context.seen.has(input)) options.fail(`${options.label} contains a cycle at ${path}.`);
  context.seen.add(input);
  try {
    return Array.isArray(input) ? cloneArray(input, path, depth, context) : cloneObject(input, path, depth, context);
  } finally {
    context.seen.delete(input);
  }
}

/** Clone plain JSON data while enforcing limits before any full serialization. */
export function cloneBoundedJson(value: unknown, options: BoundedJsonOptions): unknown {
  return cloneValue(value, "$", 0, { options, bytes: 0, seen: new WeakSet<object>() });
}
