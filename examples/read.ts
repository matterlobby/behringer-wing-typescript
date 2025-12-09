import { Wing } from '../src';

async function main(): Promise<void> {
  const property = process.argv[2] ?? '/$stat/time';
  const nodeId = Wing.nameToId(property);
  if (nodeId === undefined) {
    throw new Error(`Unknown property ${property}`);
  }

  console.log(`Connecting to Wing and requesting ${property} (${nodeId})...`);
  const wing = await Wing.connect();
  await wing.requestNodeData(nodeId);

  while (true) {
    const response = await wing.read();
    if (response.type === 'node-data' && response.id === nodeId) {
      console.log(`${property} => ${response.data.getString()}`);
      break;
    }
  }

  await wing.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
