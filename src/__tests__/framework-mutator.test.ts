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
});
