import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getSortedRoutes } = require('next/dist/shared/lib/router/utils/sorted-routes');
const routes = readdirSync('app/api', { recursive: true }).filter(name => /(^|\/)route\.[jt]sx?$/.test(name)).map(name => '/api/' + name.replace(/\/?route\.[jt]sx?$/, ''));
assert.throws(() => getSortedRoutes(['/api/tasks/[id]/other','/api/tasks/[taskId]/thinking']), /different slug names/);
getSortedRoutes(routes);
console.log(`PASS ${routes.length} API routes share consistent dynamic segment names`);
