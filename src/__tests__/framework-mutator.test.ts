/**
 * Task 14.2.3: Framework mutators hook Express/Fastify without user intervention.
 * Test: require('express'); assert app.use was called internally by Softprobe.
 */

import { applyFrameworkMutators, patchExpress } from '../bootstrap/otel/framework-mutator';
import { softprobeExpressMiddleware } from '../instrumentations/express/capture';

describe('applyFrameworkMutators (Task 14.2.3)', () => {
  it('require("express") then app.get: Softprobe injects middleware so app.use was called internally', () => {
    applyFrameworkMutators();

    const express = require('express');
    // patchExpress is idempotent; required when express was already cached before the require hook ran
    patchExpress(express);

    const app = express();
    app.get('/x', (_req: unknown, res: unknown) => res);

    // Softprobe patches app.route so first route addition calls app.use(softprobeExpressMiddleware)
    const stack = app.router?.stack ?? [];
    const hasSoftprobeMiddleware = stack.some(
      (layer: { handle?: unknown }) => layer.handle === softprobeExpressMiddleware
    );
    expect(hasSoftprobeMiddleware).toBe(true);
  });

  it('injects middleware when Express 4 style app.get delegates to _router.route', () => {
    type TestApp = {
      _router: { route: (path: string) => unknown };
      use: jest.Mock;
      get: (path: string, handler: (req: unknown, res: unknown) => unknown) => unknown;
      _softprobeMiddlewareAdded?: boolean;
    };
    type TestProto = {
      route: (path: string) => unknown;
      use: (fn: unknown) => unknown;
      get: (path: string, handler: (req: unknown, res: unknown) => unknown) => unknown;
      _softprobeRoutePatched?: boolean;
    };

    const proto: TestProto = {
      route(this: TestApp, path: string) {
        return this._router.route(path);
      },
      use(this: TestApp, fn: unknown) {
        return this.use(fn);
      },
      get(this: TestApp, path: string, _handler: (req: unknown, res: unknown) => unknown) {
        return this._router.route(path);
      },
    };
    const mockExpress = Object.assign(
      () => {
        const app = Object.create(proto) as TestApp;
        app.use = jest.fn();
        app._router = { route: jest.fn() };
        return app;
      },
      { application: proto }
    ) as unknown as (req?: unknown) => unknown;

    patchExpress(mockExpress);

    const app = mockExpress() as TestApp;
    app.get('/v4', () => undefined);

    expect(app.use).toHaveBeenCalledWith(softprobeExpressMiddleware);
  });
});
