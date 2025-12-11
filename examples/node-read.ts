

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
    // Request data for the given node id. For real node trees this should
    // trigger a stream of "node-data" responses until a "request-end".
    await wing.requestNodeData(nodeId);

    let nodeDataCount = 0;
    const start = Date.now();

    // Read responses until we see a "request-end" marker from the console.
    // We deliberately do not filter by id here, because a tree request is
    // expected to return many different ids (all children of this node).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await wing.read();

      if (response.type === 'node-data') {
        nodeDataCount += 1;

        // Optionally show the first few entries for inspection.
        if (nodeDataCount <= 5) {
          const valuePreview = (() => {
            if (response.data.isString()) {
              return response.data.getString();
            }
            if (response.data.isFloat()) {
              return response.data.getFloat().toString();
            }
            if (response.data.isInt()) {
              return response.data.getInt().toString();
            }
            return '';
          })();

          console.log(
            `node-data #${nodeDataCount}: id=${response.id}, value=${valuePreview}`,
          );
        }
      } else if (response.type === 'request-end') {
        const durationMs = Date.now() - start;
        console.log(
          `Request finished: received ${nodeDataCount} node-data entries in ${durationMs} ms.`,
        );
        break;
      }

      // Ignore other response types (node-def, unsolicited updates, etc.) for now.
    }
  } finally {
    await wing.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
