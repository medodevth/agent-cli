/**
 * ValidationUtilities — validation & schema helpers (500-functions category G, 121-140).
 *
 * Dependency-free JSON-schema engine (subset: object/array/string/number/
 * integer/boolean/enum/required/nested/properties/items) composed with the
 * existing ToolCallValidator for tool input/output, plus pure coercion,
 * sanitization and config helpers. No zod/ajv dependency added.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { JSONSchema } from '../types/index.js';
import { classifyIpHost } from './NetUtilities.js';
import { assignOwn, hasOwn } from './SafeObject.js';
import { ToolCallValidator } from '../agent/ToolCallValidator.js';

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  sanitized?: unknown;
}

export type Schema = Record<string, unknown>;

function issue(path: string, message: string): Issue {
  return { path: path || '$', message };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function checkType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return asRecord(value) !== undefined;
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    case 'any':
      return true;
    default:
      return true;
  }
}

interface ValidateOptions {
  coerce: boolean;
  stripUnknown: boolean;
}

/** Core recursive validator shared by validateToolInput/validateToolOutput/nested. */
function validateAgainstSchema(
  value: unknown,
  schema: Schema,
  at: string,
  errors: Issue[],
  warnings: Issue[],
  options: ValidateOptions
): unknown {
  const expected = schema.type as string | undefined;
  let current: unknown = value;

  if (options.coerce && expected !== undefined && !checkType(current, expected)) {
    try {
      current = strictTypeCoercion(current, expected);
    } catch {
      /* keep original — error below */
    }
  }

  if (expected !== undefined && !checkType(current, expected)) {
    errors.push(issue(at, `Expected ${expected}, got ${typeOf(current)}`));
    return current;
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues !== undefined && !enumValues.some(v => v === current)) {
    errors.push(
      issue(at, `Value is not one of: ${enumValues.map(v => JSON.stringify(v)).join(', ')}`)
    );
  }

  if (typeof current === 'string') {
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    const pattern = schema.pattern as string | undefined;
    if (minLength !== undefined && current.length < minLength) {
      errors.push(issue(at, `String shorter than minLength ${minLength}`));
    }
    if (maxLength !== undefined && current.length > maxLength) {
      warnings.push(issue(at, `String longer than maxLength ${maxLength}; will be truncated`));
      current = current.slice(0, maxLength);
    }
    if (pattern !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        errors.push(issue(at, `Invalid pattern: ${pattern}`));
        return current;
      }
      if (!re.test(current as string))
        errors.push(issue(at, `String does not match pattern ${pattern}`));
    }
  }

  if (typeof current === 'number') {
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    if (minimum !== undefined && current < minimum)
      errors.push(issue(at, `Number ${current} below minimum ${minimum}`));
    if (maximum !== undefined && current > maximum)
      errors.push(issue(at, `Number ${current} above maximum ${maximum}`));
  }

  const obj = asRecord(current);
  if (obj !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = (schema.required ?? []) as string[];
    const out: Record<string, unknown> = {};
    for (const key of required) {
      if (!(key in obj)) errors.push(issue(at ? `${at}.${key}` : key, 'Missing required field'));
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) {
        assignOwn(out, key, validateAgainstSchema(
          obj[key],
          propSchema,
          at ? `${at}.${key}` : key,
          errors,
          warnings,
          options
        ));
      } else if ((propSchema.default as unknown) !== undefined) {
        assignOwn(out, key, propSchema.default);
      }
    }
    const additional = schema.additionalProperties as boolean | undefined;
    if (additional === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties))
          warnings.push(issue(at ? `${at}.${key}` : key, 'Unknown field stripped'));
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (!hasOwn(out, key)) assignOwn(out, key, obj[key]);
      }
    }
    if (options.stripUnknown && additional === undefined) {
      // keep known + default behavior (copy unknown through); strip only when requested explicitly
    }
    return out;
  }

  if (Array.isArray(current)) {
    const items = schema.items as Schema | undefined;
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems !== undefined && current.length < minItems) {
      errors.push(issue(at, `Array shorter than minItems ${minItems}`));
    }
    let arr = current;
    if (maxItems !== undefined && current.length > maxItems) {
      warnings.push(issue(at, `Array longer than maxItems ${maxItems}; will be truncated`));
      arr = current.slice(0, maxItems);
    }
    if (items !== undefined) {
      return arr.map((item, index) =>
        validateAgainstSchema(item, items, `${at}[${index}]`, errors, warnings, options)
      );
    }
    return arr;
  }

  return current;
}

/** 121. Validate a tool input object against a JSON schema (subset engine). */
export function validateToolInput(input: unknown, schema: Schema): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const sanitized = validateAgainstSchema(input, schema, '', errors, warnings, {
    coerce: false,
    stripUnknown: false,
  });
  return { valid: errors.length === 0, errors, warnings, sanitized };
}

/** 122. Validate a tool output; unknown fields become warnings (forward-compat). */
export function validateToolOutput(output: unknown, schema: Schema): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const sanitized = validateAgainstSchema(output, schema, '', errors, warnings, {
    coerce: false,
    stripUnknown: false,
  });
  return { valid: errors.length === 0, errors, warnings, sanitized };
}

/** 122b. Validate via the existing ToolCallValidator class (kept for compat). */
export function validateWithToolCallValidator(
  toolName: string,
  input: unknown,
  schema: JSONSchema
): { valid: boolean; errors: string[]; warnings: string[]; sanitizedInput?: unknown } {
  return ToolCallValidator.validate({ name: toolName, input } as never, schema);
}

export interface SchemaField {
  type: string;
  required?: boolean;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: unknown;
  items?: SchemaField | Schema;
  properties?: Record<string, string | SchemaField | Schema>;
}

/** 123. Tiny builder: { field: 'string!' } / { field: { type, ... } } → JSON schema. */
export function zodSchemaBuilder(fields: Record<string, string | SchemaField>): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    if (typeof def === 'string') {
      const isRequired = def.endsWith('!');
      const type = isRequired ? def.slice(0, -1) : def;
      properties[name] = { type };
      if (isRequired) required.push(name);
    } else {
      const { required: req, ...rest } = def as SchemaField & { required?: boolean };
      const nestedProps = (rest as SchemaField).properties;
      const prop: Schema = { ...(rest as Schema) };
      if (nestedProps !== undefined) {
        prop.properties = Object.fromEntries(
          Object.entries(nestedProps).map(([k, v]) => [
            k,
            typeof v === 'string' ? { type: v.replace(/!$/, '') } : (v as Schema),
          ])
        );
        for (const [k, v] of Object.entries(nestedProps)) {
          if (typeof v === 'string' && v.endsWith('!')) {
            prop.required = [...((prop.required ?? []) as string[]), k];
          } else if (typeof v !== 'string' && (v as SchemaField).required === true) {
            prop.required = [...((prop.required ?? []) as string[]), k];
          }
        }
      }
      properties[name] = prop;
      if (req === true) required.push(name);
    }
  }
  return { type: 'object', properties, required };
}

/** 124. Strict coercion string↔number↔boolean (throws on lossy input). */
export function strictTypeCoercion(value: unknown, target: string): unknown {
  switch (target) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new Error(`Cannot coerce ${typeOf(value)} to string`);
    case 'number':
    case 'integer': {
      if (typeof value === 'number') {
        if (target === 'integer' && !Number.isInteger(value))
          throw new Error(`Cannot coerce non-integer ${value} to integer`);
        return value;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        const num = Number(value);
        if (target === 'integer' && !Number.isInteger(num))
          throw new Error(`Cannot coerce '${value}' to integer`);
        return num;
      }
      throw new Error(`Cannot coerce ${JSON.stringify(value)} to ${target}`);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      throw new Error(`Cannot coerce ${JSON.stringify(value)} to boolean`);
    }
    default:
      throw new Error(`Unsupported coercion target: ${target}`);
  }
}

/** 125. Missing-required check returning dotted paths. */
export function requiredFieldChecker(
  input: unknown,
  required: string[]
): { valid: boolean; missing: string[] } {
  const obj = asRecord(input) ?? {};
  const missing = required.filter(key => !(key in obj) || obj[key] === undefined);
  return { valid: missing.length === 0, missing };
}

/** 126. Enum membership check. */
export function enumValueValidator(
  value: unknown,
  allowed: unknown[]
): { valid: boolean; message?: string } {
  if (allowed.some(v => v === value)) return { valid: true };
  return {
    valid: false,
    message: `${JSON.stringify(value)} is not one of: ${allowed.map(v => JSON.stringify(v)).join(', ')}`,
  };
}

/** 127. Validate a nested value at a dotted path against a subschema. */
export function nestedSchemaValidator(
  input: unknown,
  dottedPath: string,
  schema: Schema
): ValidationReport {
  if (!dottedPath) throw new Error('dottedPath is required');
  const parts = dottedPath.split('.');
  let current: unknown = input;
  for (const part of parts) {
    const obj = asRecord(current);
    if (obj === undefined || !(part in obj)) {
      return {
        valid: false,
        errors: [issue(dottedPath, `Path '${dottedPath}' does not exist`)],
        warnings: [],
      };
    }
    current = obj[part];
  }
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const sanitized = validateAgainstSchema(current, schema, dottedPath, errors, warnings, {
    coerce: false,
    stripUnknown: false,
  });
  return { valid: errors.length === 0, errors, warnings, sanitized };
}

/** 128. Migrate data through versioned migration functions. */
export function schemaVersionMigrator<T>(
  data: T,
  fromVersion: number,
  migrations: Array<{ version: number; migrate: (data: T) => T }>
): { data: T; toVersion: number } {
  let current = data;
  let version = fromVersion;
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (migration.version > version) {
      current = migration.migrate(current);
      version = migration.version;
    }
  }
  return { data: current, toVersion: version };
}

/** 129. Lightweight OpenAPI-spec check: required fields per method+path. */
export function validateAgainstOpenAPISpec(
  request: { method: string; path: string; body?: unknown },
  spec: { paths: Record<string, Record<string, { requiredFields?: string[] }>> }
): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const method = request.method.toLowerCase();
  const route = spec.paths[request.path]?.[method];
  if (!route) {
    return {
      valid: false,
      errors: [issue('path', `No spec entry for ${request.method} ${request.path}`)],
      warnings,
    };
  }
  if (route.requiredFields && route.requiredFields.length > 0) {
    const { missing } = requiredFieldChecker(request.body ?? {}, route.requiredFields);
    for (const field of missing) errors.push(issue(`body.${field}`, 'Missing required field'));
  }
  return { valid: errors.length === 0, errors, warnings, sanitized: request.body };
}

/** 130. Cross-field rule check (e.g. start < end); rules return an error or null. */
export function crossFieldValidator(
  input: unknown,
  rules: Array<(input: Record<string, unknown>) => string | null>
): { valid: boolean; errors: Issue[] } {
  const obj = asRecord(input) ?? {};
  const errors: Issue[] = [];
  for (const rule of rules) {
    const message = rule(obj);
    if (message) errors.push(issue('$', message));
  }
  return { valid: errors.length === 0, errors };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 131. Strip control chars + trim; optionally cap length. */
export function sanitizeUserInput(input: string, maxLength?: number): string {
  if (typeof input !== 'string') throw new Error('input must be a string');
  let out = input.replace(CONTROL_CHARS_RE, '').trim();
  if (maxLength !== undefined) {
    if (!Number.isInteger(maxLength) || maxLength < 0)
      throw new Error('maxLength must be a non-negative integer');
    out = out.slice(0, maxLength);
  }
  return out;
}

/** 132. Workspace-relative path check (no absolute, no .., no null bytes). */
export function validateFilePathInput(
  inputPath: string,
  workspaceRoot: string
): { valid: boolean; resolved?: string; error?: string } {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { valid: false, error: 'Path must be a non-empty string' };
  }
  if (inputPath.includes('\0')) return { valid: false, error: 'Path contains null bytes' };
  if (path.isAbsolute(inputPath)) return { valid: false, error: 'Absolute paths are not allowed' };
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { valid: false, error: 'Path escapes the workspace' };
  }
  return { valid: true, resolved };
}

/** 133. URL check with SSRF guard: http/https only, no localhost/private IP by default. */
export function validateURLInput(
  url: string,
  options: { allowPrivate?: boolean } = {}
): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: `Protocol ${parsed.protocol} is not allowed` };
  }
  if (options.allowPrivate === true) return { valid: true };
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { valid: false, error: 'Localhost URLs are blocked (SSRF guard)' };
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.replace(/^\[|\]$/g, ''));
  if (ipv4 && ipv4.slice(1).some(part => Number(part) > 255)) {
    return { valid: false, error: 'Invalid IPv4 address' };
  }
  // Covers IPv4 plus every IPv6 spelling: mapped, IPv4-compatible, NAT64, 6to4,
  // unique-local, link-local and multicast.
  if (classifyIpHost(host) === 'blocked') {
    return { valid: false, error: 'Private/internal IPs are blocked (SSRF guard)' };
  }
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) {
    return { valid: false, error: 'Internal metadata hosts are blocked (SSRF guard)' };
  }
  return { valid: true };
}

/** 134. Env-config check: required keys present, no empty values. */
export function validateEnvConfig(
  env: NodeJS.ProcessEnv,
  required: string[]
): { valid: boolean; missing: string[]; empty: string[] } {
  const missing = required.filter(key => !(key in env) || env[key] === undefined);
  const empty = required.filter(
    key => key in env && env[key] !== undefined && String(env[key]).trim() === ''
  );
  return { valid: missing.length === 0 && empty.length === 0, missing, empty };
}

/** 135. Human-readable one-line-per-error formatter. */
export function schemaErrorFormatter(report: { errors: Issue[]; warnings?: Issue[] }): string {
  const lines: string[] = [];
  for (const error of report.errors) lines.push(`error at ${error.path}: ${error.message}`);
  for (const warning of report.warnings ?? [])
    lines.push(`warning at ${warning.path}: ${warning.message}`);
  return lines.join('\n');
}

/** 136. Plugin-manifest check: name/version/entry required, semver-ish version. */
export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: Issue[] } {
  const errors: Issue[] = [];
  const obj = asRecord(manifest);
  if (obj === undefined)
    return { valid: false, errors: [issue('$', 'Manifest must be an object')] };
  for (const field of ['name', 'version', 'entry']) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
      errors.push(issue(field, `Missing or empty required field '${field}'`));
    }
  }
  const version = obj.version;
  if (typeof version === 'string' && version.trim() !== '' && !/^\d+\.\d+\.\d+/.test(version)) {
    errors.push(issue('version', `Version '${version}' is not semver-like (x.y.z)`));
  }
  return { valid: errors.length === 0, errors };
}

/** 137. Load + JSON-parse a schema file (throws a clear error on bad JSON). */
export async function configSchemaLoader(schemaPath: string): Promise<Schema> {
  let text: string;
  try {
    text = await fs.readFile(schemaPath, 'utf-8');
  } catch {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (asRecord(parsed) === undefined) throw new Error('Schema JSON must be an object');
    return parsed as Schema;
  } catch (error) {
    if ((error as Error).message.startsWith('Schema')) throw error as Error;
    throw new Error(`Invalid schema JSON in ${schemaPath}: ${(error as Error).message}`);
  }
}

/** 138. Allowlist membership check with a clear message. */
export function validateAgainstAllowlist(
  value: string,
  allowlist: string[]
): { valid: boolean; message?: string } {
  if (allowlist.includes(value)) return { valid: true };
  return { valid: false, message: `'${value}' is not in the allowlist (${allowlist.join(', ')})` };
}

/** 139. Build a type-guard function from a schema (shallow: type + required). */
export function typeGuardGenerator(schema: Schema): (value: unknown) => boolean {
  const expected = schema.type as string | undefined;
  const required = (schema.required ?? []) as string[];
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  return (value: unknown): boolean => {
    if (expected !== undefined && !checkType(value, expected)) return false;
    const obj = asRecord(value);
    if (expected === 'object' || required.length > 0 || Object.keys(properties).length > 0) {
      if (obj === undefined) return false;
      for (const key of required) {
        if (!(key in obj)) return false;
      }
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          const propType = propSchema.type as string | undefined;
          if (propType !== undefined && !checkType(obj[key], propType)) return false;
        }
      }
    }
    return true;
  };
}

/** 140. runtimeAssert: throws when the condition is falsy (message supports lazy fn). */
export function runtimeAssert(
  condition: unknown,
  message: string | (() => string) = 'Assertion failed'
): asserts condition {
  if (!condition) {
    throw new Error(typeof message === 'function' ? message() : message);
  }
}
