

import { Wing } from '../src';

/**
 * Experimental script to request a whole node (tree) from the Wing
 * and log how many node-data entries are returned.
 *
 * Usage:
 *   npx ts-node examples/node-read.ts [nodePath]
 *
 * Examples:
 *   npx ts-node examples/node-read.ts /ch
 *   npx ts-node examples/node-read.ts /$stat
 */
async function main(): Promise<void> {
  // Default to "/ch" as this is a large, interesting node tree.
  const nodePath = process.argv[2] ?? '/ch';
  const nodeId = Wing.nameToId(nodePath);

  if (nodeId === undefined) {
    throw new Error(`Unknown node ${nodePath}`);
  }

  console.log(`Connecting to Wing and requesting node ${nodePath} (id=${nodeId})...`);
  const wing = await Wing.connect();

  try {
    const start = Date.now();
    const entries = await wing.getNodeTree(nodeId);
    const durationMs = Date.now() - start;

    console.log(
      `Request finished: received ${entries.length} node-data entries in ${durationMs} ms.`,
    );

    entries.slice(0, 100).forEach((entry, index) => {
      const valuePreview = (() => {
        if (entry.data.isString()) {
          return entry.data.getString();
        }
        if (entry.data.isFloat()) {
          return entry.data.getFloat().toString();
        }
        if (entry.data.isInt()) {
          return entry.data.getInt().toString();
        }
        return '';
      })();

      const fullname = entry.fullname ?? '(unknown)';
      console.log(`#${index + 1} ${fullname} (${entry.id}) => ${valuePreview}`);
    });
  } finally {
    await wing.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
