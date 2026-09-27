/**
 * Plugin store: workspace-local JS/TS modules that contribute tools.
 *
 * A plugin is a directory with a `plugin.json` manifest:
 *
 *   { "name": "hello", "version": "1.0.0", "entry": "index.mjs", "description": "..." }
 *
 * The manifest is validated with the shared `validatePluginManifest` utility, and
 * the entry module is imported with `await import()`. Installing writes files;
 * loading is a separate, explicit step (`load`) so a download never executes
 * code by itself.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Tool } from '../types/index.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { validatePluginManifest } from '../utils/ValidationUtilities.js';
import { safeJoin } from './SkillStore.js';
import { ExtensionSource, PluginInfo, RemoteFile } from './types.js';

export const PLUGIN_MANIFEST = 'plugin.json';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface PluginManifest {
  name: string;
  version: string;
  entry: string;
  description?: string;
}

export class PluginStore {
  private loaded = new Map<string, { tools: string[]; error?: string }>();

  constructor(private readonly root: string) {}

  get dir(): string {
    return this.root;
  }

  list(): PluginInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const plugins: PluginInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(this.root, entry.name);
      let manifest: PluginManifest;
      try {
        manifest = this.readManifest(dir);
      } catch {
        continue; // a directory without a valid manifest is not a plugin
      }
      const state = this.loaded.get(entry.name);
      plugins.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        entry: manifest.entry,
        path: dir,
        loaded: Boolean(state && !state.error),
        tools: state?.tools ?? [],
        ...(state?.error ? { error: state.error } : {}),
        source: this.readSource(dir),
      });
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  }

  private readManifest(dir: string): PluginManifest {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8'));
    } catch (error) {
      throw new PluginError(`Could not read ${PLUGIN_MANIFEST}: ${(error as Error).message}`);
    }
    const result = validatePluginManifest(raw);
    if (!result.valid) {
      throw new PluginError(result.errors.map((e) => e.message ?? String(e)).join('; '));
    }
    return raw as PluginManifest;
  }

  /** Install downloaded files as a plugin (writes only; nothing is executed). */
  install(name: string, files: RemoteFile[], source: ExtensionSource, opts: { overwrite?: boolean } = {}): PluginInfo {
    const safe = assertName(name);
    if (!files.some((f) => f.path === PLUGIN_MANIFEST)) throw new PluginError(`A plugin needs a ${PLUGIN_MANIFEST} at its root`);
    const dir = path.join(this.root, safe);
    if (fs.existsSync(dir) && !opts.overwrite) {
      throw new PluginError(`Plugin '${safe}' is already installed (pass overwrite to replace it)`);
    }
    const staging = `${dir}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const file of files) {
      const target = safeJoin(staging, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    // Validate before publishing: a broken manifest must not replace a working one.
    this.readManifest(staging);
    fs.writeFileSync(path.join(staging, '.source.json'), `${JSON.stringify(source, null, 2)}\n`, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
    fs.renameSync(staging, dir);
    this.loaded.delete(safe);
    return this.list().find((p) => p.name === safe) as PluginInfo;
  }

  /**
   * Import a plugin's entry module and register the tools it exports.
   *
   * Accepted exports: an array `tools`, a single `tool`, or a `register(registry)`
   * function — enough to cover the shapes people write without a spec document.
   */
  async load(name: string, registry: ToolRegistry): Promise<PluginInfo> {
    const safe = assertName(name);
    const dir = path.join(this.root, safe);
    if (!fs.existsSync(dir)) throw new PluginError(`Plugin '${safe}' is not installed`);
    const manifest = this.readManifest(dir);
    const entryPath = safeJoin(dir, manifest.entry);
    if (!fs.existsSync(entryPath)) throw new PluginError(`Entry '${manifest.entry}' does not exist`);

    try {
      const module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
      const contributed = registerPluginModule(module, registry);
      this.loaded.set(safe, { tools: contributed });
    } catch (error) {
      const message = (error as Error).message;
      this.loaded.set(safe, { tools: [], error: message });
      throw new PluginError(`Plugin '${safe}' failed to load: ${message}`);
    }
    return this.list().find((p) => p.name === safe) as PluginInfo;
  }

  /** Unregister a plugin's tools (the module itself stays imported). */
  unload(name: string, registry: ToolRegistry): void {
    const safe = assertName(name);
    const state = this.loaded.get(safe);
    for (const tool of state?.tools ?? []) registry.unregister(tool);
    this.loaded.delete(safe);
  }

  remove(name: string): void {
    const safe = assertName(name);
    const dir = path.join(this.root, safe);
    if (!fs.existsSync(dir)) throw new PluginError(`Plugin '${safe}' is not installed`);
    fs.rmSync(dir, { recursive: true, force: true });
    this.loaded.delete(safe);
  }

  private readSource(dir: string): ExtensionSource {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.source.json'), 'utf8')) as ExtensionSource;
      if (raw && (raw.kind === 'github' || raw.kind === 'local')) return raw;
    } catch {
      /* no provenance recorded */
    }
    return { kind: 'local' };
  }
}

function assertName(name: string): string {
  const trimmed = (name || '').trim();
  if (!NAME_RE.test(trimmed) || trimmed.includes('..')) {
    throw new PluginError(`Invalid name '${name}': use letters, digits, dot, dash or underscore (max 64 chars)`);
  }
  return trimmed;
}

/** Register whatever the module offers and return the names it contributed. */
export function registerPluginModule(module: Record<string, unknown>, registry: ToolRegistry): string[] {
  const contributed: string[] = [];
  const add = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    const tool = candidate as Tool;
    if (typeof tool.name !== 'string' || typeof tool.execute !== 'function') return;
    if (registry.has(tool.name)) return; // never let a plugin shadow a built-in
    registry.register(tool);
    contributed.push(tool.name);
  };

  const register = module.register;
  if (typeof register === 'function') {
    (register as (r: ToolRegistry) => unknown)(registry);
  }
  if (Array.isArray(module.tools)) module.tools.forEach(add);
  if (module.tool) add(module.tool);
  if (module.default) {
    if (Array.isArray(module.default)) module.default.forEach(add);
    else add(module.default);
  }
  return contributed;
}
