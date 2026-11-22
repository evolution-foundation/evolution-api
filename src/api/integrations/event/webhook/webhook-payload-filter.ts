export interface WebhookPayloadFilterOptions {
  excludeFields?: unknown;
  includeFields?: unknown;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DELETED = Symbol('deleted');

function normalizeFieldPaths(fields: unknown): string[][] {
  if (!Array.isArray(fields)) {
    return [];
  }

  const paths: string[][] = [];
  for (const field of fields) {
    if (typeof field !== 'string') {
      continue;
    }
    const trimmed = field.trim();
    if (!trimmed) {
      continue;
    }
    const segments = trimmed.split('.').filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => FORBIDDEN_KEYS.has(segment))) {
      continue;
    }
    paths.push(segments);
  }

  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      cloned[key] = cloneValue(value[key]);
    }
    return cloned as T;
  }
  return value;
}

function pickPath(
  source: unknown,
  target: unknown,
  segments: string[],
  index: number,
): { matched: boolean; value: unknown } {
  if (index >= segments.length) {
    return { matched: true, value: cloneValue(source) };
  }

  if (source === null || source === undefined || typeof source !== 'object') {
    return { matched: false, value: target };
  }

  const key = segments[index];

  if (Array.isArray(source)) {
    const result: unknown[] = Array.isArray(target) ? [...target] : new Array(source.length);
    let anyMatched = false;

    if (/^\d+$/.test(key)) {
      const idx = Number(key);
      if (idx >= 0 && idx < source.length) {
        const sub = pickPath(source[idx], result[idx], segments, index + 1);
        if (sub.matched) {
          result[idx] = sub.value;
          anyMatched = true;
        }
      }
      return { matched: anyMatched, value: anyMatched ? result : target };
    }

    for (let i = 0; i < source.length; i++) {
      const sub = pickPath(source[i], result[i], segments, index);
      if (sub.matched) {
        result[i] = sub.value;
        anyMatched = true;
      }
    }

    return { matched: anyMatched, value: anyMatched ? result : target };
  }

  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    return { matched: false, value: target };
  }

  const container: Record<string, unknown> = isPlainObject(target) ? target : {};
  const sub = pickPath((source as Record<string, unknown>)[key], container[key], segments, index + 1);
  if (!sub.matched) {
    return { matched: false, value: target };
  }

  container[key] = sub.value;
  return { matched: true, value: container };
}

function omitPath(target: unknown, segments: string[], index: number): void {
  if (target === null || target === undefined || typeof target !== 'object' || index >= segments.length) {
    return;
  }

  const key = segments[index];

  if (Array.isArray(target)) {
    if (/^\d+$/.test(key)) {
      const idx = Number(key);
      if (idx >= 0 && idx < target.length) {
        if (index === segments.length - 1) {
          target[idx] = DELETED;
        } else {
          omitPath(target[idx], segments, index + 1);
        }
      }
      return;
    }

    for (const item of target) {
      omitPath(item, segments, index);
    }
    return;
  }

  if (!isPlainObject(target)) {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    return;
  }

  if (index === segments.length - 1) {
    delete target[key];
    return;
  }

  omitPath(target[key], segments, index + 1);
}

function pruneArrays(value: unknown, shouldKeep: (arr: unknown[], index: number) => boolean): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (shouldKeep(value, i)) {
        result.push(pruneArrays(value[i], shouldKeep));
      }
    }
    return result;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      value[key] = pruneArrays(value[key], shouldKeep);
    }
    return value;
  }
  return value;
}

/**
 * Filters a webhook `data` payload according to `includeFields` and `excludeFields`
 * without mutating the input object.
 *
 * When no filters are configured, the original `data` reference is returned unchanged.
 */
export function filterWebhookPayload<T>(
  data: T,
  options?: WebhookPayloadFilterOptions,
): T | Partial<T> | Record<string, unknown> {
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }

  const hasIncludeFilter = Array.isArray(options?.includeFields) && options.includeFields.length > 0;
  const includePaths = normalizeFieldPaths(options?.includeFields);
  const excludePaths = normalizeFieldPaths(options?.excludeFields);

  if (hasIncludeFilter && includePaths.length === 0) {
    return (Array.isArray(data) ? [] : {}) as T | Partial<T> | Record<string, unknown>;
  }

  if (includePaths.length === 0 && excludePaths.length === 0) {
    return data;
  }

  let result: unknown;

  if (includePaths.length > 0) {
    const initialTarget = Array.isArray(data) ? [] : {};
    let picked: unknown = initialTarget;
    let anyMatched = false;

    for (const segments of includePaths) {
      const step = pickPath(data, picked, segments, 0);
      if (step.matched) {
        picked = step.value;
        anyMatched = true;
      }
    }

    if (!anyMatched) {
      result = Array.isArray(data) ? [] : {};
    } else {
      result = pruneArrays(picked, (arr, i) => i in arr && arr[i] !== undefined);
    }
  } else {
    result = cloneValue(data);
  }

  if (excludePaths.length > 0) {
    for (const segments of excludePaths) {
      omitPath(result, segments, 0);
    }
    result = pruneArrays(result, (arr, i) => arr[i] !== DELETED);
  }

  return result as T | Partial<T> | Record<string, unknown>;
}
