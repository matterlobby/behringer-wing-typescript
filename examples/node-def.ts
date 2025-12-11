import { Wing } from '../src';

/**
 * Fetches and prints the definition metadata of a node by numeric ID.
 *
 * Usage:
 *   npx ts-node --project tsconfig.examples.json examples/node-def.ts <nodeId>
 */
async function main(): Promise<void> {
  const idArg = process.argv[2];
  if (!idArg) {
    throw new Error('Usage: node-def.ts <nodeId>');
  }
  const nodeId = Number(idArg);
  if (!Number.isFinite(nodeId)) {
    throw new Error(`Invalid numeric node ID: ${idArg}`);
  }

  console.log(`Connecting to Wing and requesting definition for ID ${nodeId}...`);
  const wing = await Wing.connect();

  try {
    await wing.requestNodeDefinition(nodeId);
    let definition;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await wing.read();
      if (response.type === 'node-def' && response.definition.id === nodeId) {
        definition = response.definition;
      } else if (response.type === 'request-end') {
        break;
      }
    }

    if (!definition) {
      throw new Error(`Wing did not return a definition for ID ${nodeId}`);
    }

    console.log('Definition:');
    console.log(definition.toDescription());
    console.log('\nJSON representation:');
    console.log(JSON.stringify(definition.toJSON(), null, 2));
  } finally {
    await wing.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
