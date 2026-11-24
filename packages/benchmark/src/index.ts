/**
 * The Spatial Workspace Framework's performance benchmark (§26.1): the seeded standard and stress
 * fixtures, a host that presents a fixture through the framework as an application would, the
 * measures taken in the page while a scenario runs, the statistics results are reported in, and a
 * probe of what the page's code holds of the browser, for disposal soaks.
 */
export type {
  Fixture,
  FixtureSize,
  FixtureSurface,
  FixtureViewport,
  FixtureWindow,
} from './fixture.js';
export {
  DRAWN_ADAPTER,
  LIVE_ADAPTER,
  PAGE,
  planFixture,
  sizeIssue,
  STANDARD,
  STRESS,
} from './fixture.js';
export type { BenchmarkHost, BenchmarkHostOptions, HostViewport } from './host.js';
export { createBenchmarkHost, layoutViewports } from './host.js';
export type { FrameRecorder, PickRecorder, PreviewLatency, PreviewRecorder } from './measure.js';
export {
  recordControl,
  recordFrames,
  recordPicks,
  recordPreviewLatency,
  timePicks,
} from './measure.js';
export type { ResourceCounts, ResourceProbe } from './probe.js';
export { createResourceProbe } from './probe.js';
export type { FrameAnalysis, Growth, Summary } from './stats.js';
export {
  analyseFrames,
  FRAME_BUDGET_MS,
  growthExponent,
  HISTOGRAM,
  meetsFrameBudget,
  quantile,
  summarize,
} from './stats.js';
