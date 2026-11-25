# Known limitations

What SWF does not do, or does not do yet. Each item says why and what a host can do meanwhile.

## By design

- **Live content is not warped exactly.** A browser cannot bend arbitrary interactive DOM; in a
  curved view a live element is exact at its corners and approximate in between, and says so.
  Content that must look exact in a curve is drawn by the geometry backend instead.
- **Live and drawn content occlude by layers**, not per pixel: the browser has no depth test
  between an element and a canvas.
- **The platform pointer cannot be moved.** The wrapped cursor is drawn by the page and stops at
  the screen's edge.
- **No trust model.** SWF does not sandbox content or the modules a host loads; the host and the
  browser decide what runs.
- **Content is outside the accessibility guarantee.** The reference application's controls meet
  WCAG 2.2 AA; what a window shows is the host's.

## Not yet done

- **Publishing.** The packages are not on a registry: their scope, licence and registry wait on
  the owner's decision. They are `private` and `UNLICENSED` until then.
- **Safari.** The suites run in Playwright's WebKit on Linux, which is not Safari; Safari itself
  is checked once the suites run on macOS.
- **Firefox's performance on Windows.** The Windows test guests run Firefox without a desktop
  session, so it composites in software and has no system focus there; its verdicts come from a
  Linux desktop.
- **Development tools with moderate advisories.** `npm audit` reports moderate advisories in the
  linting tools (minimatch through `eslint` 10.14.0 and `typescript-eslint` 8.72.1, fixed by
  `eslint` 10.15.0 and `typescript-eslint` 8.73.0; the documentation generator `typedoc` 0.28.20
  reaches the same minimatch advisory, and no release of it is fixed yet) and in the reference
  application's UI kit's own test runner (`vitest` 4.1.0, a development tool of the kit, installed
  in its folder because the kit is linked from a checkout, never part of what a host installs). The
  tools are taken at the fixed versions once those are two weeks old; nothing a host installs is
  affected.
