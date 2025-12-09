import { Wing } from '../src';

async function main(): Promise<void> {
  const host = process.argv[2];
  const wing = await Wing.connect(host);
  console.log('Connected to Wing. Listening for property changes (Ctrl+C to exit)...');

  while (true) {
    const response = await wing.read();
    if (response.type === 'node-data') {
      const defs = Wing.idToDefs(response.id);
      const value = response.data.getString();
      if (!defs || defs.length === 0) {
        console.log(`<Unknown:${response.id}> = ${value}`);
      } else if (defs.length === 1) {
        console.log(`${defs[0].fullname} = ${value}`);
      } else {
        // IDs shared across multiple properties (dynamic contexts).
        console.log(`<MultiProp:${response.id}> = ${value}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
