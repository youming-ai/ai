// Facade — keeps `import { … } from '../data/api'` working while the
// implementation lives in cache/explore/health.
export type { Env } from './cache';
export { json } from './cache';
export * from './explore';
export { healthReport } from './health';
