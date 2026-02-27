import fs from 'node:fs';
import path from 'node:path';

describe('task 2.9 - init wiring uses instrumentation package entry points', () => {
  it('imports instrumentation setup from package folders only', () => {
    const initPath = path.resolve(__dirname, '../init.ts');
    const source = fs.readFileSync(initPath, 'utf8');

    expect(source).toContain("require('./instrumentations/fetch')");
    expect(source).toContain("require('./instrumentations/postgres')");
    expect(source).toContain("require('./instrumentations/redis')");
    expect(source).not.toContain("require('./replay/http')");
    expect(source).not.toContain("require('./replay/postgres')");
    expect(source).not.toContain("require('./replay/redis')");
  });
});
