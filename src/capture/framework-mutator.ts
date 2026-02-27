/**
 * Framework mutators: patch Express and Fastify so Softprobe middleware/hooks
 * are applied without user intervention. Design §16: patch Express app.use so
 * first middleware/route addition triggers our middleware; patch Fastify factory
 * so new instances get the plugin registered.
 */

import type { Module } from 'module';
import shimmer from 'shimmer';
import { softprobeExpressMiddleware } from '../instrumentations/express/capture';
import { softprobeFastifyPlugin } from '../instrumentations/fastify/capture';

const nodeRequire = (typeof require !== 'undefined' ? require : undefined) as NodeRequire | undefined;

/**
 * Patch Express so the first time a route is added (e.g. app.get), we call
 * app.use(softprobeExpressMiddleware) so Softprobe middleware is injected.
 * Express 5 uses app.route() for app.get/post/etc., and mixin(app, proto) copies
 * proto onto each app, so we must patch the shared proto (express.application).
 */
export function patchExpress(express: (req?: unknown) => unknown): void {
  if (typeof express !== 'function') return;
  const exp = express as { application?: { route?: (...args: unknown[]) => unknown; _softprobeRoutePatched?: boolean } };
  const proto = exp.application ?? Object.getPrototypeOf(express());
  if (!proto || typeof proto.route !== 'function') return;
  if (proto._softprobeRoutePatched) return;
  proto._softprobeRoutePatched = true;

  shimmer.wrap(proto, 'route', (original: (...args: unknown[]) => unknown) => {
    return function route(this: { use: (fn: unknown) => unknown; _softprobeMiddlewareAdded?: boolean }, ...args: unknown[]) {
      if (!this._softprobeMiddlewareAdded) {
        this._softprobeMiddlewareAdded = true;
        this.use(softprobeExpressMiddleware);
      }
      return original.apply(this, args);
    };
  });
}

/**
 * Patches Node's require so that when 'express' or 'fastify' is required,
 * the framework is patched to inject Softprobe middleware/hooks. Call from init
 * so that user require('express') or require('fastify') gets the patched version.
 */
export function applyFrameworkMutators(): void {
  if (!nodeRequire) return;

  const Mod = (typeof module !== 'undefined' && module.constructor) as (new () => Module) | undefined;
  if (!Mod?.prototype?.require) return;

  const req = nodeRequire as NodeRequire & { cache?: NodeRequire['cache'] };
  const originalRequire = Mod.prototype.require;
  Mod.prototype.require = function (this: Module, id: string) {
    const result = originalRequire.apply(this, arguments as unknown as [id: string]);
    try {
      if (id === 'express') patchExpress(result);
      if (id === 'fastify') {
        const ModLoad = nodeRequire('module') as { _resolveFilename: (id: string, parent: Module) => string };
        const path = ModLoad._resolveFilename(id, this as Module);
        const mod = req.cache?.[path];
        if (mod) {
          const orig = mod.exports as unknown;
          const origFactory = (typeof orig === 'function' ? orig : (orig as Record<string, unknown>).fastify ?? (orig as Record<string, unknown>).default) as (opts?: unknown) => unknown;
          if (typeof origFactory !== 'function') return result;
          const wrapped = fastifyWrapper(origFactory as (o?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }>);
          (wrapped as unknown as Record<string, unknown>).fastify = wrapped;
          (wrapped as unknown as Record<string, unknown>).default = wrapped;
          if (typeof orig === 'object' && orig !== null) {
            const o = orig as Record<string, unknown>;
            for (const k of Object.keys(o)) {
              if (k !== 'fastify' && k !== 'default' && Object.prototype.hasOwnProperty.call(o, k)) {
                (wrapped as unknown as Record<string, unknown>)[k] = o[k];
              }
            }
          }
          (mod as NodeModule).exports = typeof orig === 'object' && orig !== null
            ? Object.assign({}, orig as object, { fastify: wrapped, default: wrapped })
            : wrapped;
          return (mod as NodeModule).exports;
        }
      }
    } catch (_) {
      // ignore patch errors
    }
    return result;
  };

  // Patch already-cached express if present (so test can require after mutator runs)
  const cache = (typeof require !== 'undefined' && (require as NodeRequire).cache) || {};
  for (const key of Object.keys(cache)) {
    if (key.endsWith('node_modules/express/index.js') || key.endsWith('node_modules/express/lib/express.js')) {
      try {
        const mod = cache[key as keyof typeof cache];
        if (mod?.exports) patchExpress(mod.exports);
      } catch (_) {}
      break;
    }
  }
  for (const key of Object.keys(cache)) {
    if (key.endsWith('node_modules/fastify/fastify.js') || key.endsWith('node_modules/fastify/build/fastify.js')) {
      try {
        const mod = cache[key as keyof typeof cache] as NodeModule & { exports: unknown };
        const ex = mod?.exports as unknown;
        const F = (typeof ex === 'function' ? ex : (ex as Record<string, unknown>)?.fastify ?? (ex as Record<string, unknown>)?.default) as (opts?: unknown) => unknown;
        if (typeof F === 'function') {
          const wrapped = fastifyWrapper(F as (o?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }>);
          (wrapped as unknown as Record<string, unknown>).fastify = wrapped;
          (wrapped as unknown as Record<string, unknown>).default = wrapped;
          if (typeof ex === 'object' && ex !== null) {
            const o = ex as Record<string, unknown>;
            for (const k of Object.keys(o)) {
              if (k !== 'fastify' && k !== 'default' && Object.prototype.hasOwnProperty.call(o, k)) {
                (wrapped as unknown as Record<string, unknown>)[k] = o[k];
              }
            }
          }
          mod.exports = typeof ex === 'object' && ex !== null
            ? Object.assign({}, ex as object, { fastify: wrapped, default: wrapped })
            : wrapped;
        }
      } catch (_) {}
      break;
    }
  }
}

function fastifyWrapper(
  original: (options?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }>
): (options?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }> {
  return function (this: unknown, options?: unknown) {
    return Promise.resolve(original.call(this, options)).then((app) => {
      const fp = nodeRequire?.('fastify-plugin');
      const plugin = typeof fp === 'function' ? fp(softprobeFastifyPlugin) : softprobeFastifyPlugin;
      return app.register(plugin).then(() => app);
    });
  };
}
