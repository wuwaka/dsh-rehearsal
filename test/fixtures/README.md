# Test fixtures

These two `.asar` archives exist so the host-catalog probes parse a REAL
@electron/asar container (hand-built buffers only cover the negative paths —
see `buildMiniAsar` in `../desktops.test.js`). Neither file contains any
application code, binary, artwork or license text from the official desktop
bundle:

- `official-desktop.asar` — one `dsh/desktop-runtime.json` descriptor
  (schemaVersion 1 shape, the layout the catalog probes read) plus a 6-byte
  placeholder `native/binding.node`. The descriptor carries the package NAME
  and VERSION manifest of the official desktop runtime — factual metadata
  (a bill of materials), kept verbatim because the parser tests depend on
  real boundaries, e.g. `dsh-tools` NOT matching the `dsh-tool-` prefix.
- `official-desktop-nodescriptor.asar` — the same layout with an unparseable
  descriptor, for the package.json-fallback probe path.

Redistribution: package names and semver versions are uncopyrightable facts;
nothing here originates from any licensed artwork or code. The word
"official" refers to the install LAYOUT being mimicked, not to the contents
being official property.
