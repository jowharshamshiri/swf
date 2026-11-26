import type { Id } from '@swf/core';
import type { RenderFrame, Representation } from '@swf/presentation';
import { mapScene } from './map.js';

/**
 * The workspace as the panorama shows it now, in the reader's terms: how many windows the space
 * holds, how many the panorama shows and how many lie behind the camera, how each window is shown
 * for its distance (whole, compact or by its name alone), and where the camera faces. Read from a
 * frame the panorama presented, so it says what is on screen.
 */
export interface SpaceStatus {
  /** The active windows in the space. */
  readonly windows: number;
  /** The windows the panorama shows some of. */
  readonly inView: number;
  /** The windows whose centre lies behind the camera's heading. */
  readonly behind: number;
  /** The windows shown, by how they are shown: whole, as a compact preview, by their name. */
  readonly shown: Readonly<Record<Representation, number>>;
  /** The camera's heading, in whole degrees to the right of straight ahead, -179 to 180. */
  readonly facing: number;
}

/** How fully each way of showing a window shows it: a window shown several ways counts its fullest. */
const FULLNESS: Readonly<Record<Representation, number>> = Object.freeze({
  full: 2,
  compact: 1,
  label: 0,
});

/**
 * The status of the space a frame of the viewport shows, each window's part link read under the
 * host's `partKey`.
 */
export function spaceStatus(frame: RenderFrame, partKey: string): SpaceStatus {
  const scene = mapScene(frame.scene, frame.viewportId, partKey);
  const shownAs = new Map<Id, Representation>();
  for (const planned of frame.planned) {
    const owner = frame.scene.surfaces.get(planned.fragment.surfaceId)?.ownerNodeId;
    if (owner === undefined) {
      continue;
    }
    const before = shownAs.get(owner);
    if (before === undefined || FULLNESS[planned.representation] > FULLNESS[before]) {
      shownAs.set(owner, planned.representation);
    }
  }
  const windows = new Set(scene.markers.map((m) => m.id));
  const shown: Record<Representation, number> = { full: 0, compact: 0, label: 0 };
  let inView = 0;
  for (const [id, representation] of shownAs) {
    if (windows.has(id)) {
      inView += 1;
      shown[representation] += 1;
    }
  }
  const degrees = Math.round((scene.camera.heading * 180) / Math.PI);
  return Object.freeze({
    windows: windows.size,
    inView,
    behind: scene.markers.filter((m) => m.side === 'behind').length,
    shown: Object.freeze(shown),
    facing: degrees - 360 * Math.ceil((degrees - 180) / 360),
  });
}
