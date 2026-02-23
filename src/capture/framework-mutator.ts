/**
 * Framework mutators: patch Express and Fastify so Softprobe middleware/hooks
 * are applied without user intervention. Design §16: patch Express app.use so
 * first middleware/route addition triggers our middleware; patch Fastify factory
 * so new instances get the plugin registered.
 */

import type { Module } from 'module';
import shimmer from 'shimmer';
import { softprobeExpressMiddleware } from './express';
import { softprobeFastifyPlugin } from './fastify';

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
      if (id === 'fastify' && typeof result === 'function') {
        const ModLoad = nodeRequire('module') as { _resolveFilename: (id: string, parent: Module) => string };
        const path = ModLoad._resolveFilename(id, this as Module);
        const mod = req.cache?.[path];
        if (mod) {
          const orig = mod.exports as (options?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }>;
          (mod as NodeModule).exports = function fastifyWrapper(this: unknown, options?: unknown) {
            return Promise.resolve(orig.call(this, options)).then((app) =>
              app.register(softprobeFastifyPlugin).then(() => app)
            );
          };
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
        const ex = mod?.exports;
        const F = ex && typeof ex === 'object' && ex !== null && 'default' in ex
          ? (ex as { default: (o?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }> }).default
          : (ex as (options?: unknown) => Promise<{ register: (p: unknown) => Promise<void> }>);
        if (typeof F === 'function') {
          const wrapped = fastifyWrapper(F);
          mod.exports = ex && typeof ex === 'object' && ex !== null && 'default' in ex
            ? Object.assign({}, ex, { default: wrapped })
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
    return Promise.resolve(original.call(this, options)).then((app) =>
      app.register(softprobeFastifyPlugin).then(() => app)
    );
  };
}
