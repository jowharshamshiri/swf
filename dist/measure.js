/**
 * Starts recording the timestamp of every animation frame of `view`, from the next one, by
 * requesting one frame after another. The caller must call {@link FrameRecorder.stop}, which ends
 * the requests.
 */
export function recordFrames(view) {
    const stamps = [];
    const tick = (time) => {
        stamps.push(time);
        request = view.requestAnimationFrame(tick);
    };
    let request = view.requestAnimationFrame(tick);
    let found = null;
    return {
        stop() {
            if (found === null) {
                view.cancelAnimationFrame(request);
                found = Object.freeze([...stamps]);
            }
            return found;
        },
    };
}
/**
 * The control a run is read against: the page itself moving one plain element every animation
 * frame, with no framework, for `durationMs`, on a page of the given size. What the browser
 * manages here is what the machine and the browser can give a page at all; a run's frames are
 * read against it. Resolves to the frames' timestamps, in milliseconds.
 *
 * The control's page element is appended to `parent` and removed again when it is done.
 *
 * @param size - The page's size, in CSS pixels.
 * @param durationMs - How long to run, in milliseconds by the window's frame clock.
 * @throws `Error` (as a rejection) when `parent` is not in a window.
 */
export async function recordControl(parent, size, durationMs) {
    const document = parent.ownerDocument;
    const view = document.defaultView;
    if (view === null) {
        throw new Error('the parent element is not in a window');
    }
    const page = document.createElement('div');
    const box = document.createElement('div');
    for (const [element, styles] of [
        [
            page,
            {
                position: 'absolute',
                left: '0',
                top: '0',
                width: `${String(size.width)}px`,
                height: `${String(size.height)}px`,
                overflow: 'hidden',
            },
        ],
        [
            box,
            {
                position: 'absolute',
                left: '0',
                top: '0',
                width: '400px',
                height: '300px',
                background: '#dde4ee',
                font: '14px sans-serif',
            },
        ],
    ]) {
        for (const [property, value] of Object.entries(styles)) {
            element.style.setProperty(property, value);
        }
    }
    box.textContent = 'control';
    page.append(box);
    parent.append(page);
    const frames = recordFrames(view);
    const started = view.performance.now();
    await new Promise((resolve) => {
        const move = (time) => {
            const t = time - started;
            const x = (size.width - 400) * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 2000));
            box.style.setProperty('transform', `translate(${x.toFixed(2)}px, ${String(size.height / 3)}px)`);
            if (t < durationMs) {
                view.requestAnimationFrame(move);
            }
            else {
                resolve();
            }
        };
        view.requestAnimationFrame(move);
    });
    const stamps = frames.stop();
    page.remove();
    return stamps;
}
/**
 * Records how long each pointer move over the host's first viewport takes to become visible while
 * it previews a window's move: from the event's own timestamp (when the browser received the
 * input, as the DOM input device passes it on) to the start of the animation frame after the one
 * whose presentation showed the window where that move put it, or somewhere a later move put it.
 * That next frame begins once the presented one is painted, so the measure includes the paint.
 * A move is counted only while a preview of `nodeId` is open. The caller must stop the recorder.
 *
 * @throws `Error` when the host has no viewport or is not in a window.
 */
export function recordPreviewLatency(host, nodeId) {
    const main = host.viewports[0];
    if (main === undefined) {
        throw new Error('the host has no viewport');
    }
    const view = main.container.ownerDocument.defaultView;
    if (view === null) {
        throw new Error('the host is not in a window');
    }
    /** Pointer moves not yet shown: when each happened, and the place it previewed. */
    const pending = [];
    /** Moves presented, waiting for the frame after their presentation, by its request. */
    const painting = new Map();
    const latencies = [];
    let maxPending = 0;
    // Observed as the router returns, the preview this move made is in place.
    const stopInput = host.observeInput((intent) => {
        if (intent.kind !== 'pointer' || intent.phase !== 'move') {
            return;
        }
        const place = host.workspace.getPresented().nodes.get(nodeId)?.transform;
        const committed = host.workspace.getState().nodes.get(nodeId)?.transform;
        if (place === undefined || place === committed) {
            return; // no preview of the window is open: this move previews nothing
        }
        pending.push({ at: intent.timestamp, place });
        maxPending = Math.max(maxPending, pending.length);
    });
    const stopFrames = host.presenter.subscribe((event) => {
        if (event.type !== 'frame' || event.viewportId !== main.fixture.id) {
            return;
        }
        const shown = main.viewport.lastFrame()?.frame.scene.nodes.get(nodeId)?.transform;
        const index = pending.findLastIndex((p) => p.place === shown);
        if (index < 0) {
            return;
        }
        const done = pending.splice(0, index + 1);
        const request = view.requestAnimationFrame((painted) => {
            painting.delete(request);
            for (const p of done) {
                latencies.push(painted - p.at);
            }
        });
        painting.set(request, done);
    });
    let found = null;
    return {
        stop() {
            if (found === null) {
                stopInput();
                stopFrames();
                let unpainted = 0;
                for (const [request, done] of painting) {
                    view.cancelAnimationFrame(request);
                    unpainted += done.length;
                }
                painting.clear();
                found = Object.freeze({
                    latencies: Object.freeze([...latencies]),
                    unshown: pending.length + unpainted,
                    maxPending,
                });
            }
            return found;
        },
    };
}
/**
 * Starts recording the time of every hit query the host's router makes for pointer input, as the
 * router timed it. The caller must call {@link PickRecorder.stop}, which stops observing input.
 */
export function recordPicks(host) {
    const times = [];
    const stop = host.observeInput((intent, result) => {
        if (intent.kind === 'pointer' && result.pick !== null) {
            times.push(result.pick.ms);
        }
    });
    let found = null;
    return {
        stop() {
            if (found === null) {
                stop();
                found = Object.freeze([...times]);
            }
            return found;
        },
    };
}
/**
 * Times hit queries at points of a viewport, `perPoint` queries at each so that coarse browser
 * clocks still resolve them (Firefox and Safari round `performance.now` to a millisecond or
 * more): each point's time is its queries' time divided by their number. Returns milliseconds per
 * query, one value per point.
 *
 * @param points - Points of the viewport, in CSS pixels from its top left.
 * @param perPoint - Queries at each point: a whole number of at least 1, not checked.
 * @throws `Error` when the host is not in a window.
 */
export function timePicks(host, viewportId, points, perPoint) {
    const view = host.viewports[0]?.container.ownerDocument.defaultView;
    if (view === null || view === undefined) {
        throw new Error('the host is not in a window');
    }
    return points.map(([x, y]) => {
        const started = view.performance.now();
        for (let i = 0; i < perPoint; i++) {
            host.router.pick(viewportId, x, y);
        }
        return (view.performance.now() - started) / perPoint;
    });
}
//# sourceMappingURL=measure.js.map