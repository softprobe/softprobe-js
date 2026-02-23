/**
 * Fixture for run-child.test: prints RUN_CHILD_ECHO env or "hello", exits with EXIT_CODE or 0.
 * Plain Node script so child can be run with `node` (no ts-node).
 */
const msg = process.env.RUN_CHILD_ECHO || 'hello';
console.log(msg);
const code = parseInt(process.env.EXIT_CODE || '0', 10);
process.exit(code);
