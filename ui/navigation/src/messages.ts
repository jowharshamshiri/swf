import type { StandInReason } from '@swf/presentation';
import type { NavigationCommandId, NavigationWords } from '@swf/navigation';

/**
 * Every string the navigation controls show, by a stable message ID. The controls ship English; a
 * host supplies a translation pack for another locale, or its own catalogue that holds these and
 * its own ({@link createMessages}). Messages take named parameters (`{name}`), and numbers are
 * formatted for the locale only when shown: the scene itself always holds plain numbers in world
 * units.
 */
export const NAVIGATION_ENGLISH = Object.freeze({
  'mode.label': 'View mode',
  'mode.panorama': 'Panorama',
  'mode.focus': 'Focus',
  'mode.map': 'Map',
  'mode.overview': 'Overview',
  'command.mode.switch': 'Switch mode',
  'command.mode.switch.named': 'Show the {mode} view',
  'command.mode.back': 'Go back to the view before',
  'command.backend.switch': 'Developer: Switch backend',
  'command.backend.switch.named': 'Developer: Present with the {backend} backend',
  'command.window.reveal': 'Go to window',
  'command.window.reveal.named': 'Go to {label}',
  'command.focus.enter': 'Focus a window',
  'command.focus.enter.named': 'Focus {label}',
  'command.focus.exit': 'Close focus',
  'command.focus.toggle': 'Focus a window, or close its focus',
  'command.focus.step': 'Focus the next window',
  'command.focus.step.left': 'Focus the next window to the left',
  'command.focus.step.right': 'Focus the next window to the right',
  'command.window.map': 'Show a window in the map',
  'command.window.inspect': 'Inspect a window',
  'command.selection.toggle': 'Add a window to the selection, or take it out',
  'command.window.place': 'Place a window',
  'command.window.pose': 'Move or size a window',
  'command.window.lock': 'Lock or unlock a window',
  'command.window.lock.named': 'Lock {label}',
  'command.window.unlock.named': 'Unlock {label}',
  'command.feature.set': 'Turn a feature on or off',
  'command.feature.set.on': 'Turn on {feature}',
  'command.feature.set.off': 'Turn off {feature}',
  'command.feature.reset': 'Reset the features to the combined defaults',
  'command.snap.configure': 'Set magnetic positioning',
  'command.depth.configure': 'Set the semantic depth bands',
  'command.navigation.set': 'Choose what background drags turn',
  'command.navigation.camera': 'Background drags turn the camera',
  'command.navigation.orbit': 'Background drags turn the workspace',
  'command.orbit.designate': 'Designate the orbit group',
  'command.orbit.turn': 'Turn the workspace',
  'command.orbit.turn.left': 'Turn the workspace left',
  'command.orbit.turn.right': 'Turn the workspace right',
  'command.orbit.turnTo': 'Turn the workspace to a heading',
  'command.view.fov': 'Set the field of view',
  'command.view.heading': 'Turn the camera to a heading',
  'command.window.arrange': 'Arrange the windows round the camera',
  'command.window.bringFront': 'Bring a window in front of the camera',
  'command.window.bringFront.named': 'Bring {label} in front of the camera',
  'command.window.sendBehind': 'Send a window behind the camera',
  'command.window.sendBehind.named': 'Send {label} behind the camera',
  'command.history.undo': 'Undo',
  'command.history.redo': 'Redo',
  'command.gesture.cancel': 'Cancel the gesture',
  'command.gesture.grab': 'Pick a window up',
  'command.gesture.grab.named': 'Pick up {label}',
  'command.gesture.drop': 'Put the held window down',
  'focus.label': 'Focused window',
  'focus.title': 'Focus: {label}',
  'focus.close': 'Close focus',
  'focus.context': 'Windows around the focused one',
  'focus.left': '{label}, {degrees}° left',
  'focus.right': '{label}, {degrees}° right',
  'focus.more.left': '{count} more to the left',
  'focus.more.right': '{count} more to the right',
  'focus.alone': 'No other windows',
  'focus.next': 'Next window',
  'focus.strip.label': 'Every window round you',
  'focus.strip.role': 'window strip',
  'focus.strip.hint': 'Every other window, where it lies round you: press one to focus it',
  'focus.strip.keys': 'Left and right arrows focus the next window that way.',
  'focus.hint':
    'Press a window in the strip below to focus it; with the strip’s keyboard stop, ← and → focus the next window that way; Next window steps right; Escape closes the focus.',
  'focus.hint.short': 'Press a window below to focus it',
  'focus.strip.hidden': 'Not in the strip: {labels}',
  'radar.title': 'Radar',
  'radar.label': 'The workspace around the camera, from above',
  'radar.help':
    'Up is straight ahead as the scene was made. Drag a window to move it round the camera, behind it too; press one to select it, double-press it to focus it.',
  'radar.show': 'Show the radar',
  'radar.hide': 'Hide the radar',
  'radar.legend':
    'Rings: distance in units · shaded: behind the camera · wedge: what the panorama shows · filled dot: in front · hollow, dashed: behind · faded: out of view · ringed: focused',
  'radar.locate': 'Centre on the selected',
  'radar.arrange': 'Arrange round',
  'view.controls': 'The view',
  'view.fov': 'Field of view',
  'view.fov.outside':
    'The panorama is shown {value}° wide, wider or narrower than this control sets.',
  'view.fov.whole': 'Show the whole circle',
  'view.fov.focus': 'Focus frames its window: close it to set the field of view.',
  'view.heading': 'Camera heading',
  'view.workspace': 'Workspace turned',
  'view.workspace.off': 'Workspace rotation is off in Experiments.',
  'view.workspace.noroot': 'No group is designated for workspace orbit.',
  'radar.ring': '{value}',
  'radar.bearing': '{value}°',
  'guides.behind': 'Behind the camera',
  'guides.seam': 'Seam',
  'guides.facing': 'Facing {value}°',
  'map.label': 'The workspace from above',
  'map.help':
    'Drag a window to move it, double-press it to focus it, drag the ground to pan, and scroll to zoom. The fields beside the map place the selected window exactly, its height too.',
  'map.zoom.in': 'Zoom in',
  'map.zoom.out': 'Zoom out',
  'map.recentre': 'Centre the map on the camera',
  'map.scale': '{value} pixels per unit',
  'map.controls': 'Map',
  'map.placement': 'Placement',
  'map.none': 'Nothing selected',
  'map.none.detail': 'Press a window on the map, or pick one from the windows list, to place it.',
  'map.x': 'Across (X)',
  'map.z': 'Ahead and behind (Z)',
  'map.height': 'Height (Y)',
  'map.height.hint': 'Units above the camera’s eye level.',
  'map.number.invalid': 'A position is a number of units.',
  'map.side.front': 'In front of the camera',
  'map.side.behind': 'Behind the camera',
  'map.front': 'In front',
  'map.behind': 'Behind',
  'map.camera': 'Camera',
  'map.ring': '{value} units',
  'overview.label': 'Every window round the camera, as cards',
  'overview.help':
    'Straight ahead is in the middle, behind at both edges, above at the top. Press a card to select its window, double-press it to focus it.',
  'overview.list': 'Windows found',
  'overview.none': 'Select a window to act on it.',
  'overview.shown': '{shown} of {count} windows',
  'overview.more': 'Show {count} more',
  'overview.region.ahead': 'Ahead',
  'overview.region.left': 'Left',
  'overview.region.right': 'Right',
  'overview.region.behind': 'Behind',
  'overview.where': '{heading}° {side} · {distance} units',
  'overview.parts': '{count} parts',
  'overview.crowded': 'Too many windows to show {count} cards here',
  'overview.crowded.detail':
    'Each window is a dot where it stands; the list beside names every one. A larger view has room for cards.',
  'search.placeholder': 'Labels, tags, colours, categories and groups',
  'search.empty': 'No windows match',
  'search.empty.detail': 'Nothing matches the search and its filters.',
  'search.in.groups': 'In {groups}',
  'action.label': 'Actions on the selected window',
  'action.focus': 'Focus',
  'action.reveal': 'Centre the view on it',
  'action.front': 'Bring in front of the camera',
  'action.behind': 'Send behind the camera',
  'action.map': 'Show in map',
  'action.inspect': 'Inspect',
  'action.select': 'Selected along with the others',
  'view.label': 'The workspace, all the way round',
  'view.takeover': 'Hold Alt to move a window by its content',
  'view.takeover.short': 'Alt: move a window by its content',
  'panorama.role': 'spatial workspace',
  'panorama.label': 'Panorama',
  'panorama.keys':
    'Drag a window by its title bar to move it round you, its edges to resize it, and double-click its title bar to focus it; Shift and drag, or Shift and the wheel, bring it nearer or farther; Ctrl (⌘) and click add it to the selection. Arrows move the selected window, Page Up and Page Down bring it nearer or farther, + and − resize it; N and P select the next and previous window, Enter focuses it, Space picks it up, Delete removes it; Alt with arrows, or A and D, turn the camera; 1 to 4 show the views in the switcher’s order, F shows the selected window in focus, M shows the map, Escape goes back; Tab leaves the view. The Windows view lists every window.',
  'panorama.held.keys':
    'Arrows, Page Up/Down and + − change it · Enter or Space puts it down · Escape cancels',
  'where.text': '{heading}° {side}, {distance} units away, {height} units {updown}',
  'where.right': 'right',
  'where.left': 'left',
  'where.up': 'up',
  'where.down': 'down',
  'announce.selected': '{label} selected: {where}.',
  'announce.moved': '{label} moved: {where}.',
  'announce.added': '{label} added and selected: {where}.',
  'announce.resized': '{label} is now {width} by {height} units.',
  'announce.held':
    '{label} picked up: {where}. Move it with the keys, then Enter or Space puts it down and Escape cancels.',
  'announce.preview': '{label} would be {where}, {width} by {height} units.',
  'announce.dropped': '{label} put down: {where}.',
  'announce.cancelled': 'Cancelled: {label} is back where it was.',
  'announce.locked': '{label} locked.',
  'announce.unlocked': '{label} unlocked.',
  'announce.saved': 'Workspace saved.',
  'announce.undone': 'Undone.',
  'announce.redone': 'Redone.',
  'keys.refused': '{operation} did nothing: {reason}',
  'keys.locked': '{label} is locked; unlock it to move, turn or resize it.',
  'operation.node.move': 'Move',
  'operation.node.resize': 'Resize',
  'operation.gesture.grab': 'Pick up',
  'operation.gesture.drop': 'Put down',
  'operation.selection.next': 'Select the next window',
  'operation.selection.previous': 'Select the previous window',
  'operation.focus.selected': 'Focus',
  'operation.history.undo': 'Undo',
  'operation.history.redo': 'Redo',
  'operation.camera.turn': 'Turn the camera',
  'operation.orbit.turn': 'Turn the workspace',
  'operation.other': 'The key',
  'inspector.title': 'Selection',
  'inspector.none': 'Nothing selected',
  'inspector.none.detail':
    'Press a window’s title bar, hold Alt and press its content, or go to it from the command list.',
  'inspector.label': 'Selected window',
  'inspector.id': 'ID',
  'inspector.name': 'Name',
  'inspector.content': 'Content',
  'inspector.side': 'Where',
  'inspector.side.front': 'In front of the camera',
  'inspector.side.behind': 'Behind the camera',
  'inspector.position': 'Position (X, Y, Z)',
  'inspector.position.value': '{x}, {y}, {z}',
  'inspector.presentation': 'Shown as',
  'inspector.degrees': '{value}°',
  'inspector.locked': 'Locked',
  'inspector.locked.yes': 'Yes',
  'inspector.locked.no': 'No',
  'inspector.actions': 'Actions on the selected window',
  'inspector.place': 'Place',
  'inspector.place.detail':
    'Drag a slider and the window moves as you drag; letting go is one change that undo puts back. Arrow keys move it a step, and a number typed puts it exactly there.',
  'inspector.place.where': 'Where it stands',
  'inspector.place.how': 'How it stands',
  'inspector.place.heading': 'Angle',
  'inspector.place.reach': 'Distance',
  'inspector.place.y': 'Height',
  'inspector.place.width': 'Frame width',
  'inspector.place.height': 'Frame height',
  'inspector.place.units': 'units',
  'inspector.place.where.hint':
    'Angle is round you: 0° straight ahead of where you started, 90° to your right. Distance is across the ground from you; height is above or below your eyes.',
  'inspector.place.how.hint': 'Its frame is sized in units.',
  'inspector.place.locked': 'Locked: unlock it to move or resize it.',
  'inspector.place.fixed.move': 'Its host does not let it be moved.',
  'inspector.place.fixed.resize': 'Its host does not let it be resized.',
  'inspector.lock': 'Lock this window',
  'inspector.lock.detail':
    'A locked window cannot be moved or resized: not by a drag, a key or here.',
  'presentation.live': 'Its own content',
  'presentation.proxy': 'A box with its name',
  'presentation.drawn': 'Its drawn content',
  'experiments.title': 'Experiments',
  'experiments.reset': 'Reset to the combined defaults',
  'experiments.reset.detail':
    'Reset turns all eight on, as Everything combined does, and also puts every setting below back to its default.',
  'experiments.list': 'Try one capability, or all of them',
  'experiments.list.detail':
    'Each numbered experiment turns its capability on and every other off, and sets the view up to show it. Switch any capability below to combine them.',
  'experiments.switches': 'Capabilities',
  'experiments.switches.detail':
    'Each capability on or off on its own, in any combination: turning one off takes its controls away and changes no window.',
  'experiments.custom': 'Custom combination',
  'experiments.custom.trial':
    'You combined the capabilities yourself: {on}. Choose a numbered experiment to isolate one again, or keep switching.',
  'experiments.custom.none': 'none is on',
  'experiments.current': 'Experiment {number}: {name}',
  'experiment.everything': 'Everything combined',
  'experiment.everything.summary': 'All eight capabilities in one workspace',
  'experiment.everything.trial':
    'Every capability is on, in the panorama, with drags turning the camera. Move windows, switch views, turn the workspace instead of the camera, focus a window, put windows behind you. Turn any capability off below to see what it adds.',
  'experiment.focus': 'Focus and context',
  'experiment.focus.summary': 'Read one window without losing the room',
  'experiment.focus.trial':
    'The selected window is framed readably and stays editable, with its neighbours either side a press away; Escape goes back to where you were. With nothing selected, select a window and press F. Turn Focus and context off: the Focus view leaves the switcher and F does nothing.',
  'experiment.orbit': 'Workspace rotation',
  'experiment.orbit.summary': 'Turn the room, not the view',
  'experiment.orbit.trial':
    'Drag the panorama’s background: the workspace turns round you while the camera stays where it faces, and undo puts a turn back. Switch Camera | Workspace above the panorama to compare. Turn Workspace rotation off: drags turn the camera again.',
  'experiment.depth': 'Semantic depth',
  'experiment.depth.summary': 'Near shows content, far a label',
  'experiment.depth.trial':
    'Near windows show their content, farther ones a compact preview and the farthest their label alone; drag a window nearer with Shift held and its content comes back. Turn Semantic depth off: every window shows its content, however far.',
  'experiment.cursor': 'Seamless 360°',
  'experiment.cursor.summary': 'Drag past the seam behind you',
  'experiment.cursor.trial':
    'The whole circle is in view. Drag a window past the panorama’s left or right edge: it comes back in at the other, where the seam behind you is, still under the drawn cursor. Turn Seamless 360° off: the drag stops at the edge.',
  'experiment.map': 'Spatial map',
  'experiment.map.summary': 'Move things behind you from above',
  'experiment.map.trial':
    'The map shows the workspace from above, behind you too. Press a window to select it; drag it to put it anywhere round you, then look in the panorama. Turn Spatial map off: the Map view leaves the switcher and M does nothing; the radar beside the panorama stays.',
  'experiment.snap': 'Magnetic placement',
  'experiment.snap.summary': 'Snap to neighbours, spokes and rings',
  'experiment.snap.trial':
    'Drag a window near another and let go: it snaps edge to edge with a gap, lines up, and its heading snaps to the 15° spokes and its distance to the rings; the line above the panorama names the snap. Turn Magnetic placement off to compare free placement.',
  'experiment.composition': 'Multi-surface composition',
  'experiment.composition.summary': 'Break windows into linked parts',
  'experiment.composition.trial':
    'Select the Project Board and choose Break into parts in the inspector: each surface becomes a window of its own, linked to it, to move apart; Recombine parts puts them back. Turn Multi-surface composition off: the inspector offers none of it.',
  'experiment.persistence': 'Persistent workspaces',
  'experiment.persistence.summary': 'Named spaces that remember',
  'experiment.persistence.trial':
    'Move a window somewhere memorable, save the workspace under a name in Workspaces, change the scene, and open it again: every window is back where you left it. Turn Persistent workspaces off: nothing is saved and the Workspaces view leaves the side.',
  'command.experiment.run': 'Run an experiment',
  'command.experiment.run.named': 'Run experiment {number}: {name}',
  'feature.orbit': 'workspace rotation',
  'feature.depth': 'semantic depth',
  'feature.snap': 'magnetic placement',
  'feature.cursor': 'seamless 360°',
  'orbit.detail':
    'Turns a group of windows round the camera, as one change that undo puts back. Turning the camera instead changes only the view: compare the two with the choice below.',
  'orbit.enabled': 'Turn the workspace',
  'orbit.navigation': 'Background drags turn',
  'orbit.navigation.camera': 'Camera',
  'orbit.navigation.orbit': 'Workspace',
  'orbit.navigation.off': 'Workspace rotation is off: background drags turn the camera.',
  'orbit.navigation.noroot': 'No group is designated: background drags turn the camera.',
  'orbit.group': 'Orbit group',
  'orbit.group.none': 'None',
  'orbit.turn.left': 'Turn left 15°',
  'orbit.turn.right': 'Turn right 15°',
  'orbit.readings': 'Camera and workspace',
  'orbit.camera': 'Camera heading',
  'orbit.turned': 'Workspace turned',
  'orbit.announce.orbit':
    'Background drags turn the {group} group round the camera; the camera stays still. Undo puts a turn back.',
  'orbit.announce.camera': 'Background drags turn the camera.',
  'depth.detail':
    'Windows farther away show a compact preview, and the farthest only their label. Their content stays attached and keeps running.',
  'depth.enabled': 'Represent windows by distance',
  'depth.full': 'Content nearer than',
  'depth.compact': 'Compact preview nearer than',
  'depth.full.hint': 'World units from the camera.',
  'depth.compact.hint': 'World units from the camera. Farther, a window shows its label alone.',
  'snap.detail':
    'A window being moved snaps to its neighbours’ edges, lines up with them and with the horizon, and keeps a gap from them. The snap shows as you move; releasing commits it once.',
  'snap.enabled': 'Snap moved windows',
  'snap.linear': 'Edge snap distance',
  'snap.linear.hint': 'World units.',
  'snap.angular': 'Line-up angle',
  'snap.angular.hint': 'Degrees, at most 15.',
  'snap.padding': 'Gap between windows',
  'snap.padding.hint': 'World units.',
  'snap.spoke': 'Spokes every',
  'snap.spoke.hint':
    'Degrees round you, at most 90; 0 for none. A heading within the line-up angle of a spoke goes to it.',
  'snap.ring': 'Ring snap distance',
  'snap.ring.hint':
    'World units; 0 for none. A distance this near a ring goes to it: the rings are where Arrange round lays windows.',
  'cursor.detail':
    'A window or the view carried past one edge of the panorama comes back in at the other, where the seam behind you is.',
  'cursor.enabled': 'Wrap pointers at the seam',
  'cursor.limits':
    'A drag that reaches the panorama’s edge locks your pointer to the panorama: your pointer is hidden, the drag goes on round the circle as far as the mouse goes, and a drawn cursor shows where it acts. Releasing lets your pointer go where the lock took it; Escape cancels the drag and lets it go. Where the browser offers no lock, or refuses it, the drag stops at the edge of the screen.',
  'cursor.unavailable':
    'Wrapping needs the whole 360° panorama. This view shows less, so pointers do not wrap now.',
  'setting.invalid': 'Not set: {reason}',
  'navigation.status.camera': 'Drags turn the camera',
  'navigation.status.orbit': 'Drags turn the workspace',
  'gesture.label': 'The gesture',
  'gesture.help':
    'Drag: move round and up or down · Shift+drag: nearer, farther · Edges: resize · Ctrl+click: select more',
  'gesture.node.move': 'Moving {label}',
  'gesture.node.resize': 'Resizing {label}',
  'gesture.reading.size': '{width} × {height} units',
  'gesture.orbit.turn': 'Turning the workspace',
  'gesture.camera.turn': 'Turning the camera',
  'gesture.gesture.grab': 'Holding {label}',
  'gesture.drop': 'Put down (Enter)',
  'gesture.done.gesture.grab': 'Put down {label}',
  'gesture.other': 'Working',
  'gesture.preview': 'Preview: nothing is changed until you release.',
  'gesture.preview.wheel': 'Preview: nothing is changed until the wheel rests.',
  'gesture.snapped': 'Snapped: {constraints}',
  'gesture.free': 'No snap',
  'gesture.cancel': 'Cancel (Esc)',
  'gesture.done.node.move': 'Moved {label}',
  'gesture.done.node.resize': 'Resized {label}',
  'gesture.done.orbit.turn': 'Turned the workspace',
  'gesture.done.other': 'Done',
  'outcome.label': 'What the last action did',
  'outcome.bringFront': 'Brought {label} in front of you',
  'outcome.sendBehind': 'Sent {label} behind you',
  'outcome.arrange': 'Arranged the windows round you',
  'outcome.reveal': 'Turned to face {label}',
  'gesture.cancelled': 'Cancelled: nothing changed',
  'gesture.dismiss': 'Dismiss',
  'snap.edge.left': 'left edge to {label}',
  'snap.edge.right': 'right edge to {label}',
  'snap.edge.top': 'top edge to {label}',
  'snap.edge.bottom': 'bottom edge to {label}',
  'snap.align.heading': 'in line with {label}',
  'snap.align.elevation': 'level with {label}',
  'snap.horizon': 'level with the horizon',
  'snap.spoke.at': 'on the spoke at {degrees}°',
  'snap.ring.at': 'on the ring {distance} units out',
  'representation.compact': 'A compact preview, by distance',
  'representation.label': 'Its label alone, by distance',
  'error.command': '{command} failed: {reason}',
  'standIn.pending': 'Loading…',
  'standIn.unbound': 'Empty: no content is given to it',
  'standIn.unsupported': 'Unsupported: nothing here can present this content',
  'standIn.unavailable': 'Temporarily unavailable: it can be retried',
  'standIn.failed': 'Presentation failed',
  'standIn.elsewhere': 'Shown in another view',
  'feature.focus': 'focus and context',
  'feature.map': 'the spatial map',
  'feature.composition': 'multi-surface composition',
  'feature.persistence': 'persistent workspaces',
  'focus.feature.detail': 'Show one window readably, with the windows around it a press away.',
  'focus.feature.enabled': 'Offer the Focus view',
  'map.feature.detail': 'See the scene from above and move windows on the ground.',
  'map.feature.enabled': 'Offer the Map view',
  'composition.detail':
    'Rearrange the surfaces a host supplied among windows, and windows among groups. A surface is always moved whole: its own content is never split.',
  'composition.enabled': 'Rearrange surfaces and windows',
  'persistence.detail':
    'Save the workspace in this browser as it changes, save and open named workspaces, and export and import files.',
  'persistence.off': 'Changes are not saved while this is off; what is saved stays as it is.',
  'depth.off': 'Off: every window shows its content, however far it is.',
  'cursor.off': 'Off: a drag stops at the panorama’s edge.',
  'snap.off': 'Off: a moved window goes exactly where it is let go.',
  'command.window.remove': 'Remove a window from the workspace',
  'command.window.remove.named': 'Remove {label} from the workspace',
  'command.window.remove.many': 'Remove the {count} selected windows from the workspace',
  'command.surface.detach': 'Detach a surface into a window of its own',
  'command.surface.move': 'Move a surface into another window',
  'command.window.merge': 'Merge a window into another',
  'command.window.split': 'Break a window into parts',
  'command.window.recombine': 'Recombine a window’s parts',
  'command.window.regroup': 'Move a window into a group',
  'command.window.group': 'Group the selected windows',
  'action.focus.off': 'Focus and context is turned off in Experiments',
  'action.map.off': 'The spatial map is turned off in Experiments',
  'inspector.surfaces': 'Contents',
  'inspector.surfaces.detail':
    'What this window holds, side by side. Each is moved whole, never split.',
  'inspector.surface.detach': 'Detach into its own window',
  'inspector.split': 'Break into parts',
  'inspector.recombine': 'Recombine parts',
  'inspector.partOf': 'Part of',
  'inspector.partOf.value': '{label}, linked',
  'inspector.parts': 'Parts',
  'inspector.parts.value': '{count} linked windows',
  'inspector.surface.only':
    'All this window holds: there is nothing to detach it from, and it is never split.',
  'inspector.surface.move': 'Move to window',
  'inspector.surface.move.choose': 'Choose a window',
  'inspector.surface.move.surface': 'Choose what to move',
  'inspector.window.group.choose': 'Choose a group',
  'inspector.window.merge': 'Merge into window',
  'inspector.window.group': 'Group',
  'inspector.window.group.new': 'A new group…',
  'inspector.window.group.name': 'New group’s name',
  'inspector.window.group.move': 'Move',
  'inspector.composition.off': 'Multi-surface composition is turned off in Experiments.',
  'inspector.together': 'Selected together',
  'inspector.together.detail':
    '{count} windows are selected: {names}. Ctrl+click a window in the panorama, or press Selected along with the others on its row in the Windows view, to add or take one out.',
  'inspector.together.name': 'Name of the new group',
  'inspector.together.group': 'Group them',
  'inspector.remove': 'Remove from workspace',
  'inspector.remove.detail':
    'The window leaves this workspace. Its content is the host’s: it is not deleted or stopped, and undo brings the window back.',
  'removed.text': 'Removed {label} from the workspace. Its content is not deleted or stopped.',
  'removed.windows': '{count} windows',
  'notice.dismiss': 'Dismiss',
} as const);

/** A navigation control's message, by its ID. */
export type NavigationMessageId = keyof typeof NAVIGATION_ENGLISH;

/** A message's named parameters. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** The messages of one locale, by ID. */
export interface Messages<Id extends string> {
  /** The locale, as `Intl` names it. */
  readonly locale: string;
  /** The message with its parameters filled in; numbers formatted for the locale. */
  format(id: Id, params?: MessageParams): string;
  /**
   * A message named by an ID only the running host knows (a view mode's name, which any module
   * may register): as {@link format}, or an Error naming an ID the catalogue has not.
   */
  named(id: string, params?: MessageParams): string;
  /** A number as the locale writes it. */
  number(value: number): string;
}

/** The navigation controls' messages, or a host's catalogue that holds them. */
export type NavigationMessages = Messages<NavigationMessageId>;

const PARAM = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * The messages of a locale from a catalogue: the pack's where it has them, the catalogue's English
 * otherwise. A pack naming a message the catalogue has not, or a message that names a parameter it
 * is not given, is an Error.
 */
export function createMessages<Id extends string>(
  english: Readonly<Record<Id, string>>,
  locale = 'en',
  pack?: Readonly<Partial<Record<Id, string>>>,
): Messages<Id> {
  for (const id of Object.keys(pack ?? {})) {
    if (!Object.hasOwn(english, id)) {
      throw new Error(`the translation pack names an unknown message "${id}"`);
    }
  }
  const numbers = new Intl.NumberFormat(locale);
  const format = (id: Id, params: MessageParams = {}): string => {
    const template = pack?.[id] ?? english[id];
    return template.replace(PARAM, (_, name: string) => {
      if (!Object.hasOwn(params, name)) {
        throw new Error(`message "${id}" needs the parameter "${name}"`);
      }
      const value = params[name];
      return typeof value === 'number' ? numbers.format(value) : String(value);
    });
  };
  return Object.freeze({
    locale,
    number: (value: number) => numbers.format(value),
    format,
    named(id: string, params: MessageParams = {}): string {
      if (!Object.hasOwn(english, id)) {
        throw new Error(`no message "${id}"`);
      }
      return format(id as Id, params);
    },
  });
}

/** The navigation controls' messages in a locale: English, or the pack's where it has them. */
export function createNavigationMessages(
  locale = 'en',
  pack: Readonly<Partial<Record<NavigationMessageId, string>>> = {},
): NavigationMessages {
  return createMessages<NavigationMessageId>(NAVIGATION_ENGLISH, locale, pack);
}

/** The message naming each navigation command, for a host's command list. */
export const NAVIGATION_COMMAND_NAMES: Readonly<Record<NavigationCommandId, NavigationMessageId>> =
  Object.freeze({
    'swf.mode.switch': 'command.mode.switch',
    'swf.mode.back': 'command.mode.back',
    'swf.backend.switch': 'command.backend.switch',
    'swf.window.reveal': 'command.window.reveal',
    'swf.focus.enter': 'command.focus.enter',
    'swf.focus.exit': 'command.focus.exit',
    'swf.focus.toggle': 'command.focus.toggle',
    'swf.focus.step': 'command.focus.step',
    'swf.window.map': 'command.window.map',
    'swf.window.inspect': 'command.window.inspect',
    'swf.selection.toggle': 'command.selection.toggle',
    'swf.window.place': 'command.window.place',
    'swf.window.pose': 'command.window.pose',
    'swf.window.lock': 'command.window.lock',
    'swf.feature.set': 'command.feature.set',
    'swf.feature.reset': 'command.feature.reset',
    'swf.experiment.run': 'command.experiment.run',
    'swf.snap.configure': 'command.snap.configure',
    'swf.depth.configure': 'command.depth.configure',
    'swf.navigation.set': 'command.navigation.set',
    'swf.orbit.designate': 'command.orbit.designate',
    'swf.orbit.turn': 'command.orbit.turn',
    'swf.orbit.turnTo': 'command.orbit.turnTo',
    'swf.view.fov': 'command.view.fov',
    'swf.view.heading': 'command.view.heading',
    'swf.window.arrange': 'command.window.arrange',
    'swf.window.bringFront': 'command.window.bringFront',
    'swf.window.sendBehind': 'command.window.sendBehind',
    'swf.history.undo': 'command.history.undo',
    'swf.history.redo': 'command.history.redo',
    'swf.gesture.cancel': 'command.gesture.cancel',
    'swf.gesture.grab': 'command.gesture.grab',
    'swf.gesture.drop': 'command.gesture.drop',
    'swf.window.remove': 'command.window.remove',
    'swf.surface.detach': 'command.surface.detach',
    'swf.surface.move': 'command.surface.move',
    'swf.window.merge': 'command.window.merge',
    'swf.window.split': 'command.window.split',
    'swf.window.recombine': 'command.window.recombine',
    'swf.window.regroup': 'command.window.regroup',
    'swf.window.group': 'command.window.group',
  });

/** What the viewport's element and its stand-ins say, in the navigation controls' words. */
export function navigationWords(messages: NavigationMessages): NavigationWords {
  return Object.freeze({
    role: messages.format('panorama.role'),
    label: messages.format('panorama.label'),
    keys: messages.format('panorama.keys'),
    standIn: (reason: StandInReason) => messages.format(`standIn.${reason}`),
  });
}
