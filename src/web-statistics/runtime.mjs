import { createStatisticsService } from './service.mjs';

// Share the upstream budget across routes and development module reloads in this process.
const key = Symbol.for('xhs.web-statistics.v1');
export const statisticsService = globalThis[key] ??= createStatisticsService();
