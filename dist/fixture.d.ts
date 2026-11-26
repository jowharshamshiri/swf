import type { SceneCommand } from '@swf/core';
/**
 * The performance benchmark's fixtures (§26.1): seeded, stable scenes for comparing browsers,
 * releases and modes at matching entity counts (AN-010). From a size and a seed a fixture plans the
 * same scene on every run and engine: every value comes from exact arithmetic on the seeded
 * sequence, rounded to tenths of a degree and hundredths of a world unit.
 *
 * The standard fixture holds 250 windows with 300 surfaces among them in five nested groups, seen
 * through two viewports that each show 30 to 50 surfaces wherever their cameras turn. Its content
 * is lightweight: the host's surfaces are plain elements or proxies, so frames measure the
 * framework, not content.
 */
/** How large a fixture is; {@link sizeIssue} says whether one can be planned. */
export interface FixtureSize {
    /** Windows in the scene: a positive multiple of 5, one share for each of the five rings. */
    readonly windows: number;
    /** Surfaces among the windows: from `windows` to twice `windows`. */
    readonly surfaces: number;
    /** Nested groups the windows are spread among: a positive whole number. */
    readonly groups: number;
}
/** The standard benchmark fixture's counts (§26.1). */
export declare const STANDARD: FixtureSize;
/**
 * The stress fixture: twice the standard scene, for observing how far performance degrades
 * (NFR-008), without claiming the standard's frame rates.
 */
export declare const STRESS: FixtureSize;
/** The page a fixture is measured in, in CSS pixels: the benchmark's 1920×1080. Frozen. */
export declare const PAGE: {
    /** The page's width, in CSS pixels. */
    readonly width: number;
    /** The page's height, in CSS pixels. */
    readonly height: number;
};
/** The adapter type of a live element: a plain element, shareable between viewports. */
export declare const LIVE_ADAPTER = "swf.bench.live/1";
/** The adapter type of drawn content, which the DOM backend shows as a proxy. */
export declare const DRAWN_ADAPTER = "swf.bench.drawn/1";
/** A viewport of a fixture, as the scene holds it, beside its neighbour on the page. Frozen. */
export interface FixtureViewport {
    /** The viewport's ID in the scene: `ahead` or `behind`. */
    readonly id: string;
    /** The ID of the camera it looks through. */
    readonly cameraId: string;
    /** Where its left edge stands on the page, in CSS pixels. */
    readonly left: number;
    /** Where its top edge stands on the page, in CSS pixels. */
    readonly top: number;
    /** Its width, in CSS pixels. */
    readonly width: number;
    /** Its height, in CSS pixels. */
    readonly height: number;
    /** Degrees to the right of straight ahead (-Z) its camera starts turned. */
    readonly heading: number;
    /** The equirectangular angle it shows across, in degrees: the same degrees per pixel each way. */
    readonly horizontal: number;
    /** The equirectangular angle it shows down, in degrees. */
    readonly vertical: number;
}
/** A surface of a planned window. Frozen. */
export interface FixtureSurface {
    /** The surface's ID: its window's, with `-a` or `-b`. */
    readonly id: string;
    /** {@link LIVE_ADAPTER} for a window's first surface, {@link DRAWN_ADAPTER} for its second. */
    readonly adapterTypeId: string;
    /** `bench/<seed>/<window number>/<a or b>`: unique within the fixture. */
    readonly bindingKey: string;
    /** Its centre in the window's frame, across, in world units. */
    readonly x: number;
    /** Its width, in world units. */
    readonly width: number;
    /** Its height, in world units. */
    readonly height: number;
}
/** A planned window, in the world. Frozen. */
export interface FixtureWindow {
    /** `window-<number>`, numbered from 1 and padded to the digits of the window count. */
    readonly id: string;
    /** `Window <number>`. */
    readonly label: string;
    /** The nested group it is in, `group-1` (outermost) to `group-<groups>`. */
    readonly groupId: string;
    /** Degrees to the right of straight ahead, in (-180, 180], as seen in the world. */
    readonly heading: number;
    /** Degrees above the horizon. */
    readonly elevation: number;
    /** World units from the camera. */
    readonly distance: number;
    /** Its width, in world units: 0.5 to 0.9. */
    readonly width: number;
    /** Its height, in world units: 0.32 to 0.5. */
    readonly height: number;
    /** Its one or two surfaces, side by side. */
    readonly surfaces: readonly FixtureSurface[];
}
/** A planned fixture: what it holds, and the commands that make it. Deeply frozen. */
export interface Fixture {
    /** The size it was planned at, as given. */
    readonly size: FixtureSize;
    /** The seed it was planned from. */
    readonly seed: number;
    /** `group-1` (outermost) to `group-<groups>`, each nested in the one before. */
    readonly groupIds: readonly string[];
    /** Every window, ring by ring from the lowest. */
    readonly windows: readonly FixtureWindow[];
    /** The two viewports, `ahead` and `behind`, side by side on the {@link PAGE}. */
    readonly viewports: readonly FixtureViewport[];
    /** The commands that make the whole scene in an empty workspace, as one transaction. */
    readonly commands: readonly SceneCommand[];
}
/** Why a size cannot be planned, in words, or null when it can; see {@link FixtureSize}. */
export declare function sizeIssue(size: FixtureSize): string | null;
/**
 * Plans a fixture. Windows stand in five rings round the camera, evenly spaced with a little
 * jitter, alternate rings offset by half a step; every `windows / (surfaces - windows)`-th window
 * holds two surfaces side by side, the second drawn. Window `i` is in group `i mod groups`, so
 * every depth of nesting holds windows all the way round. The same size and seed give the same
 * fixture on every run and engine.
 *
 * @throws `RangeError` for a size {@link sizeIssue} refuses, or a seed `createRandom` refuses.
 */
export declare function planFixture(size: FixtureSize, seed: number): Fixture;
//# sourceMappingURL=fixture.d.ts.map