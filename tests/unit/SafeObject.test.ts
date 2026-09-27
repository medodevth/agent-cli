import { assignOwn, hasOwn, ownGet } from '../../src/utils/SafeObject.js';

describe('hasOwn', () => {
  it('reports own properties and ignores names inherited from Object.prototype', () => {
    const object = { present: 1 };
    expect(hasOwn(object, 'present')).toBe(true);
    expect(hasOwn(object, 'missing')).toBe(false);
    expect(hasOwn(object, 'toString')).toBe(false);
    expect(hasOwn(object, 'constructor')).toBe(false);
    expect(hasOwn(object, 'hasOwnProperty')).toBe(false);
    expect(hasOwn(object, '__proto__')).toBe(false);
  });

  it('works for arrays and null-prototype objects', () => {
    expect(hasOwn(['a'], '0')).toBe(true);
    expect(hasOwn(['a'], 'length')).toBe(true);
    expect(hasOwn(['a'], 'push')).toBe(false);
    expect(hasOwn(Object.create(null), 'anything')).toBe(false);
  });
});

describe('ownGet', () => {
  it('returns own values only and never reads through the prototype chain', () => {
    const object: Record<string, string | undefined> = { present: 'value', empty: undefined };
    expect(ownGet(object, 'present')).toBe('value');
    expect(ownGet(object, 'empty')).toBeUndefined();
    expect(ownGet(object, 'missing')).toBeUndefined();
    expect(ownGet(object, 'constructor')).toBeUndefined();
    expect(ownGet(object, 'toString')).toBeUndefined();
  });

  it('ignores values inherited from a custom prototype', () => {
    const child = Object.create({ inherited: 'base' }) as Record<string, string>;
    child.own = 'self';
    expect(ownGet(child, 'inherited')).toBeUndefined();
    expect(ownGet(child, 'own')).toBe('self');
  });
});

describe('assignOwn', () => {
  it('defines an own enumerable, writable, configurable data property', () => {
    const target: Record<string, unknown> = {};
    assignOwn(target, 'key', 'value');
    expect(Object.keys(target)).toEqual(['key']);
    expect(ownGet(target, 'key')).toBe('value');
    expect(Object.getOwnPropertyDescriptor(target, 'key')).toEqual({
      value: 'value',
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it('cannot pollute Object.prototype when the dynamic key is __proto__', () => {
    const target: Record<string, unknown> = {};
    assignOwn(target, '__proto__', { polluted: true });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('polluted');
    expect(hasOwn(target, '__proto__')).toBe(true);
    expect(ownGet(target, '__proto__')).toEqual({ polluted: true });
  });

  it('shadows inherited names such as constructor with an own value', () => {
    const target: Record<string, unknown> = {};
    assignOwn(target, 'constructor', 'own');
    expect(hasOwn(target, 'constructor')).toBe(true);
    expect(ownGet(target, 'constructor')).toBe('own');
    expect(Object.keys(target)).toEqual(['constructor']);
  });
});
