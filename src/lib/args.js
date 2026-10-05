// CLI argument parsing. One deliberate rule set, in one place:
//  - every `--dashed-flag` is stored BOTH as `opts['dashed-flag']` and as
//    `opts.dashedFlag`, so command code reads one spelling while the CLI
//    accepts the documented one (the two lists drifted apart before: the
//    parser stored kebab keys while run.js read camelCase, silently ignoring
//    `--shadow-dir`, `--prefix-dir` and `--skip-write`)
//  - switches take no value; `--switch=true` and `--switch=false` are
//    accepted explicitly, and any other `=value` is an input error — a
//    `--run-scripts=false` spelled as a string must never read as "on"
//  - switches never consume the next argument

/** Options that are switches rather than value-taking flags. */
export const BOOLEAN_FLAGS = new Set(['run-scripts', 'allow-tools', 'keep', 'skip-write', 'yes', 'full']);

export function parseArgs(argv) {
  const opts = { _: [] };
  const put = (key, value) => {
    opts[key] = value;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== key) opts[camel] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        const key = a.slice(2, eq);
        const value = a.slice(eq + 1);
        if (BOOLEAN_FLAGS.has(key)) {
          if (value === 'true') put(key, true);
          else if (value === 'false') put(key, false);
          else throw new Error(`--${key} takes no value (or true/false), got ${JSON.stringify(value)}`);
        } else {
          put(key, value);
        }
      } else {
        const key = a.slice(2);
        if (BOOLEAN_FLAGS.has(key)) put(key, true);
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) put(key, argv[++i]);
        else put(key, true);
      }
    } else opts._.push(a);
  }
  return opts;
}
