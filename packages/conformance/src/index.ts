/**
 * Reusable conformance suites for the Spatial Workspace Framework's contracts, and the reference
 * mocks they run against. An adapter or backend author creates the cases with their fixture and
 * runs each one in their own test framework (each case's `run` throws on failure), or runs them
 * all with {@link runConformance}.
 */
export type { AdapterFixture } from './adapter-suite.js';
export { adapterConformance } from './adapter-suite.js';
export type { BackendFixture } from './backend-suite.js';
export { backendConformance } from './backend-suite.js';
export { ManualFrames } from './frames.js';
export type { HandoffFixture } from './handoff-suite.js';
export { handoffConformance } from './handoff-suite.js';
export type { ConformanceCase, ConformanceResult } from './harness.js';
export { ConformanceFailure, runConformance } from './harness.js';
export type { MockCall, MockHandle } from './mock-adapter.js';
export { mockCapabilities, MockOpaqueAdapter, NATIVE_CAPABILITIES } from './mock-adapter.js';
export {
  MOCK_COMPOSITOR_CAPABILITIES,
  MOCK_RENDERER_CAPABILITIES,
  MockCompositor,
  MockCompositorSession,
  MockRenderer,
  MockRendererSession,
} from './mock-backend.js';
