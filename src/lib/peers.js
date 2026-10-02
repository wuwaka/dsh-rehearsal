// Static peer-graph analysis (stage B1). Pure metadata — no downloads, no
// process spawns, works even while DSH Desktop is running and even for the
// desktop profile that the npm CLI refuses to manage.
//
// Risk shapes found on a real machine (reviews, 2026-10-02):
//  - plugin -> dsh peer pins that exclude the candidate (prerelease caret
//    does not cross minors: ^0.1.7-rc.2 excludes 0.2.0 entirely, which forces
//    authors into fragile version enumeration lists)
//  - plugin -> plugin peers (e.g. a locale helper pinned by better-sidebar)
//  - multiple conflicting pins on @deepseek-ai/cordis across plugins
//  - non-reproducible deps (link:/file:/github:)

import semver from 'semver';

/**
 * @param {Array<{name, version, peers: object, deps: object, reproducible: boolean}>} plugins
 * @param {{candidate?: string, current?: string}} targets dsh runtime versions to test against
 */
export function analyzePeerGraph(plugins, { candidate, current } = {}) {
  const findings = [];
  const byName = new Map(plugins.map((p) => [p.name, p]));

  for (const p of plugins) {
    for (const [peer, range] of Object.entries(p.peers ?? {})) {
      // 1) plugin -> dsh core. Severity distinguishes what THIS upgrade
      //    breaks from what is already broken today (audit P2-1): reporting
      //    a pre-existing mismatch as a blocking upgrade verdict cries wolf.
      if (peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-')) {
        const okC = candidate && semver.valid(candidate) ? satisfiesPrerelease(candidate, range) : null;
        const okCur = current && semver.valid(current) ? satisfiesPrerelease(current, range) : null;
        if (okC === false) {
          if (okCur === false) {
            findings.push({
              kind: 'peer-incompatible-pre-existing',
              severity: 'warn',
              plugin: p.name,
              peer,
              range,
              target: candidate,
              current,
              note: 'plugin peer excludes BOTH current and candidate dsh versions — already disabled/mismatched today, NOT caused by this upgrade',
            });
          } else if (okCur === true) {
            findings.push({
              kind: 'peer-incompatible',
              severity: 'high',
              plugin: p.name,
              peer,
              range,
              target: candidate,
              current,
              note: 'newly broken by this upgrade: plugin works on current but its peer excludes the candidate',
            });
          } else {
            findings.push({
              kind: 'peer-incompatible',
              severity: 'high',
              plugin: p.name,
              peer,
              range,
              target: candidate,
              note: 'candidate dsh version is excluded by this peer range (current runtime version unknown — re-run with --current to classify pre-existing vs newly-broken)',
            });
          }
        }
        if (okCur === false && okC !== false) {
          findings.push({
            kind: 'peer-incompatible-current',
            severity: 'info',
            plugin: p.name,
            peer,
            range,
            target: current,
            note: 'current dsh version is outside the declared range (plugin may have been force-installed); the candidate satisfies it',
          });
        }
      } else if (byName.has(peer)) {
        // 2) plugin -> plugin peer inside the same profile
        const host = byName.get(peer);
        if (host.version && !satisfiesPrerelease(host.version, range)) {
          findings.push({
            kind: 'plugin-plugin-peer-incompatible',
            severity: 'high',
            plugin: p.name,
            peer,
            range,
            resolved: host.version,
            note: 'peer requirement conflicts with the co-installed plugin version',
          });
        }
      } else if (peer === '@deepseek-ai/cordis' || peer === 'cordis') {
        // collected below for the multi-pin finding
      } else if (p.reproducible === false) {
        // peers of non-reproducible deps still noted, but flagged
      }
      // 3) peer on something entirely absent from the profile
      if (!peer.startsWith('@deepseek-ai/') && !byName.has(peer) && peer !== 'cordis') {
        findings.push({
          kind: 'peer-unresolved-in-profile',
          severity: 'warn',
          plugin: p.name,
          peer,
          range,
          note: 'peer is neither a dsh core package nor co-installed in this profile (may be satisfied by the host runtime or simply unresolved)',
        });
      }
    }
  }

  // 4) cordis multi-pin: every distinct pin across plugins is a simultaneous
  //    collapse risk when cordis jumps a major.
  const cordisPins = new Map();
  for (const p of plugins) {
    const pin = p.peers?.['@deepseek-ai/cordis'] ?? p.deps?.['@deepseek-ai/cordis'];
    if (pin) {
      if (!cordisPins.has(pin)) cordisPins.set(pin, []);
      cordisPins.get(pin).push(p.name);
    }
  }
  if (cordisPins.size > 1) {
    findings.push({
      kind: 'cordis-multi-pin',
      severity: 'warn',
      pins: Object.fromEntries(cordisPins),
      note: 'plugins pin @deepseek-ai/cordis differently; a cordis major bump can break them independently',
    });
  }

  // 5) enumeration-style ranges: the prerelease-caret workaround is fragile
  //    and silently excludes every future rc.
  for (const p of plugins) {
    for (const [peer, range] of Object.entries(p.peers ?? {})) {
      if (typeof range === 'string' && range.includes('||') && (range.match(/\|\|/g) ?? []).length >= 3) {
        findings.push({
          kind: 'enumerated-peer-range',
          severity: 'info',
          plugin: p.name,
          peer,
          range,
          note: 'version-enumerated range (prerelease-caret workaround); every new dsh rc needs a manual range edit and new rcs are silently excluded',
        });
      }
    }
  }

  // 6) non-reproducible installs
  for (const p of plugins) {
    if (p.reproducible === false) {
      findings.push({
        kind: 'non-reproducible-dependency',
        severity: 'warn',
        plugin: p.name,
        source: p.deps?.[p.name] ?? p.source,
        note: 'link:/file:/github: dependency — a shadow rehearsal cannot reproduce it faithfully',
      });
    }
  }

  return findings;
}

/**
 * semver.satisfies with explicit prerelease semantics: by default
 * satisfies() excludes prereleases unless the range opt-in via
 * [range, options]. We want standard npm semantics (a caret range over a
 * prerelease base does not match a higher-minor prerelease) — that is
 * exactly the footgun the reviews documented, so use the default strict
 * behavior: allow prerelease matches only when the range itself mentions a
 * prerelease of the same [major, minor, patch] tuple.
 */
export function satisfiesPrerelease(version, range) {
  if (typeof range !== 'string' || !range.trim()) return true; // unconstrained
  try {
    return semver.satisfies(version, range, { includePrerelease: false });
  } catch {
    return true; // unparseable range: do not report a false incompatibility
  }
}
