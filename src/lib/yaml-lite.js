// Minimal YAML helpers for the two shapes dsh patch/workspace files actually
// use. This is NOT a YAML parser — it only supports what inventory needs:
//  - counting top-level patch rows (`- id: ...` at column 0)
//  - reading a simple flat string list (`key:` followed by `- item` lines)
// Anything else (nested config blocks, !!js expressions) is deliberately not
// interpreted; we never need its semantics for read-only inventory.

/**
 * Count patch rows.
 *
 * Round-3 correction (the auditor retracted their original claim and our
 * any-indent fix over-corrected). Real desktop `cordis.patch.yml` anatomy:
 *  - 14 rows: `- id:` at column 0
 *  - 12 INDENTED `- id:` at indent 10 inside `providers: > opencode: >
 *    models:` — CONFIG ENTRIES (big-pickle / mimo-v2.5 / deepseek-flash),
 *    never rows
 *  - ONE `- insert:` block at column 0 whose children sit at indent 4 as
 *    `- name: '…'` (2 of them), each child carrying its own deep config
 * Rule: column-0 `- id:` = top rows; inside an `insert:` block only items at
 * the FIRST child-item indent count (deeper `- id:` are child config);
 * comment lines never end a block. Expected desktop total: 14 + 2 = 16.
 */
export function countRows(text) {
  let n = 0;
  let insertIndent = -1;
  let childIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    const indent = line.match(/^(\s*)/)[1].length;
    const ins = line.match(/^(\s*)-\s+insert\s*:/);
    if (ins) {
      insertIndent = ins[1].length;
      childIndent = -1;
      continue;
    }
    const item = line.match(/^(\s*)-\s+(?:id|name)\s*:/);
    if (insertIndent >= 0 && item) {
      const ii = item[1].length;
      if (ii <= insertIndent) {
        insertIndent = -1; // new top-level seq item: the block ended
      } else {
        if (childIndent === -1) childIndent = ii;
        if (ii === childIndent) n++;
        continue; // deeper items are child config, not rows
      }
    } else if (insertIndent >= 0) {
      if (line.trim() !== '' && !/^\s*#/.test(line) && indent <= insertIndent) insertIndent = -1;
      else continue;
    }
    if (/^-\s+id\s*:/.test(line)) n++;
  }
  return n;
}

/**
 * Read a flat string list under `key:` — items are lines more-indented than
 * the key, starting with `- `. Returns [] when absent. Stops at the next
 * line with indent <= the key's indent.
 */
export function simpleListAfter(text, key) {
  const lines = text.split(/\r?\n/);
  let base = -1;
  let inKey = false;
  const out = [];
  for (const line of lines) {
    if (!inKey) {
      const m = line.match(new RegExp(`^(\\s*)${key}\\s*:\\s*(?:#.*)?$`));
      if (m) {
        base = m[1].length;
        inKey = true;
      }
      continue;
    }
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= base) break;
    const item = line.match(/^\s*-\s*(.+?)\s*(?:#.*)?$/);
    if (item) out.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}
