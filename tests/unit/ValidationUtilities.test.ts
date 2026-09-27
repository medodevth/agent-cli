import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  configSchemaLoader,
  crossFieldValidator,
  enumValueValidator,
  nestedSchemaValidator,
  requiredFieldChecker,
  runtimeAssert,
  sanitizeUserInput,
  schemaErrorFormatter,
  schemaVersionMigrator,
  strictTypeCoercion,
  typeGuardGenerator,
  validateAgainstAllowlist,
  validateAgainstOpenAPISpec,
  validateEnvConfig,
  validateFilePathInput,
  validatePluginManifest,
  validateToolInput,
  validateToolOutput,
  validateURLInput,
  zodSchemaBuilder,
} from '../../src/utils/ValidationUtilities.js';

/** Category G (121-140): JSON-schema validation, coercion, sanitization. */

describe('validateToolInput (121)', () => {
  it('collects type and required field errors with stable paths', () => {
    const report = validateToolInput(
      { count: 'nope' },
      { type: 'object', required: ['name'], properties: { count: { type: 'number' } } }
    );
    expect(report.valid).toBe(false);
    expect(report.errors.map(error => error.path)).toEqual(['name', 'count']);
  });
});

describe('validateToolOutput (122)', () => {
  it('strips unknown fields from output and reports a warning', () => {
    const report = validateToolOutput(
      { ok: true, extra: 1 },
      { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }
    );
    expect(report.valid).toBe(true);
    expect(report.sanitized).toEqual({ ok: true });
    expect(report.warnings).toHaveLength(1);
  });
});

describe('zodSchemaBuilder (123)', () => {
  it('builds nested fields and required constraints', () => {
    const schema = zodSchemaBuilder({
      name: 'string!',
      profile: { type: 'object', properties: { age: 'number!' } },
    });
    expect(schema.required).toEqual(['name']);
    expect(schema.properties).toEqual({
      name: { type: 'string' },
      profile: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
    });
  });
});

describe('strictTypeCoercion (124)', () => {
  it('coerces only lossless numeric and boolean values', () => {
    expect(strictTypeCoercion('42', 'integer')).toBe(42);
    expect(strictTypeCoercion('false', 'boolean')).toBe(false);
    expect(() => strictTypeCoercion('4.2', 'integer')).toThrow();
  });
});

describe('requiredFieldChecker (125)', () => {
  it('reports absent and undefined fields', () => {
    expect(requiredFieldChecker({ present: undefined }, ['present', 'missing'])).toEqual({
      valid: false,
      missing: ['present', 'missing'],
    });
  });
});

describe('enumValueValidator (126)', () => {
  it('uses strict membership', () => {
    expect(enumValueValidator(1, [1, 2]).valid).toBe(true);
    expect(enumValueValidator('1', [1, 2]).valid).toBe(false);
  });
});

describe('nestedSchemaValidator (127)', () => {
  it('validates and returns the requested nested value', () => {
    expect(
      nestedSchemaValidator({ user: { age: 4 } }, 'user.age', { type: 'integer' })
    ).toMatchObject({ valid: true, sanitized: 4 });
  });
});

describe('schemaVersionMigrator (128)', () => {
  it('applies each later migration exactly once in version order', () => {
    const result = schemaVersionMigrator({ value: 1 }, 1, [
      { version: 3, migrate: d => ({ value: d.value + 2 }) },
      { version: 2, migrate: d => ({ value: d.value + 1 }) },
    ]);
    expect(result).toEqual({ data: { value: 4 }, toVersion: 3 });
  });
});

describe('validateAgainstOpenAPISpec (129)', () => {
  it('checks method, path and required body fields', () => {
    const result = validateAgainstOpenAPISpec(
      { method: 'POST', path: '/items', body: {} },
      { paths: { '/items': { post: { requiredFields: ['name'] } } } }
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('body.name');
  });
});

describe('crossFieldValidator (130)', () => {
  it('reports failed cross-field rules without changing input', () => {
    expect(
      crossFieldValidator({ start: 5, end: 2 }, [
        v => (Number(v.start) < Number(v.end) ? null : 'start must be before end'),
      ])
    ).toMatchObject({ valid: false, errors: [{ message: 'start must be before end' }] });
  });
});

describe('sanitizeUserInput (131)', () => {
  it('removes control characters, trims, and respects a length cap', () => {
    expect(sanitizeUserInput('  a\u0000bc  ', 2)).toBe('ab');
  });
});

describe('validateFilePathInput (132)', () => {
  it('rejects absolute paths and traversal but resolves safe relative paths', () => {
    expect(validateFilePathInput('../secret', '/workspace').valid).toBe(false);
    expect(validateFilePathInput('src/main.ts', '/workspace')).toMatchObject({
      valid: true,
      resolved: '/workspace/src/main.ts',
    });
  });
});

describe('validateURLInput (133)', () => {
  it('allows public HTTP(S) and blocks private hosts/IPs', () => {
    expect(validateURLInput('https://example.com').valid).toBe(true);
    expect(validateURLInput('http://127.0.0.1').valid).toBe(false);
    expect(validateURLInput('file:///etc/passwd').valid).toBe(false);
  });
});

describe('validateEnvConfig (134)', () => {
  it('distinguishes missing keys from empty values', () => {
    expect(
      validateEnvConfig({ PRESENT: 'ok', EMPTY: '  ' }, ['PRESENT', 'EMPTY', 'MISSING'])
    ).toEqual({ valid: false, missing: ['MISSING'], empty: ['EMPTY'] });
  });
});

describe('schemaErrorFormatter (135)', () => {
  it('formats errors and warnings with paths', () => {
    expect(
      schemaErrorFormatter({
        errors: [{ path: 'user.age', message: 'invalid' }],
        warnings: [{ path: 'extra', message: 'ignored' }],
      })
    ).toBe('error at user.age: invalid\nwarning at extra: ignored');
  });
});

describe('validatePluginManifest (136)', () => {
  it('requires the documented plugin metadata and a semantic version', () => {
    expect(
      validatePluginManifest({ name: 'plug', version: '1.2.3', entry: 'index.js' }).valid
    ).toBe(true);
    expect(validatePluginManifest({ name: 'plug', version: 'latest', entry: '' }).valid).toBe(
      false
    );
  });
});

describe('configSchemaLoader (137)', () => {
  it('loads JSON object schemas and rejects invalid or missing files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-'));
    const file = path.join(dir, 'schema.json');
    try {
      await fs.writeFile(file, '{"type":"object"}');
      await expect(configSchemaLoader(file)).resolves.toEqual({ type: 'object' });
      await fs.writeFile(file, '[]');
      await expect(configSchemaLoader(file)).rejects.toThrow('Schema JSON must be an object');
      await expect(configSchemaLoader(path.join(dir, 'missing.json'))).rejects.toThrow(
        'Schema file not found'
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validateAgainstAllowlist (138)', () => {
  it('accepts only exact allowlisted values', () => {
    expect(validateAgainstAllowlist('safe', ['safe']).valid).toBe(true);
    expect(validateAgainstAllowlist('SAFE', ['safe']).valid).toBe(false);
  });
});

describe('typeGuardGenerator (139)', () => {
  it('checks declared property types and required keys', () => {
    const guard = typeGuardGenerator({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    expect(guard({ name: 'ok' })).toBe(true);
    expect(guard({ name: 4 })).toBe(false);
    expect(guard({})).toBe(false);
  });
});

describe('runtimeAssert (140)', () => {
  it('throws lazily with the provided assertion message', () => {
    let called = false;
    const message = (): string => {
      called = true;
      return 'failed';
    };
    expect(() => runtimeAssert(false, message)).toThrow('failed');
    expect(called).toBe(true);
    called = false;
    expect(() => runtimeAssert(true, message)).not.toThrow();
    expect(called).toBe(false);
  });
});
