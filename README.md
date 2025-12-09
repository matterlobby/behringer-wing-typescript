# libwing-typescript

A TypeScript/Node.js client for controlling the Behringer Wing digital mixer. It mirrors the
behaviour of the original Rust-based `libwing` crate and supports device discovery, property
reads/writes, schema inspection, and meter streaming.

## Status

This is an early but functional port. The binary protocol encoder/decoder, keep-alive handling and
property map (over 78k entries) are implemented. More high-level helpers and tooling will be added
next.

## Installation

```bash
npm install libwing-typescript
# or
pnpm add libwing-typescript
```

Node.js 18+ is required because the library relies on the modern `net`/`dgram` APIs and Promise-based
infrastructure.

## Usage

### Discover consoles

```ts
import { Wing } from 'libwing-typescript';

async function listConsoles() {
  const consoles = await Wing.scan();
  consoles.forEach((device) => {
    console.log(`${device.name} @ ${device.ip} (${device.model})`);
  });
}
```

### Read a property once

```ts
import { Wing } from 'libwing-typescript';

async function readProperty() {
  const nodeId = Wing.nameToId('/$stat/time');
  if (nodeId === undefined) throw new Error('Unknown property');

  const wing = await Wing.connect();
  await wing.requestNodeData(nodeId);

  while (true) {
    const response = await wing.read();
    if (response.type === 'node-data' && response.id === nodeId) {
      console.log(response.data.getString());
      break;
    }
  }

  await wing.close();
}
```

### Subscribing to meters

```ts
const wing = await Wing.connect();
const meterId = await wing.requestMeter([{ kind: 'channel', index: 1 }]);

while (true) {
  const meters = await wing.readMeters();
  if (meters.meterId === meterId) {
    console.log('Channel 1 level:', meters.values[0]);
  }
}
```

Refer to `src/wing.ts` for the complete API surface. Property helpers (`nameToId`,
`nameToDef`, `idToDefs`) are backed by the JSON schema bundled at `data/propmap.jsonl`.

## Development

```bash
npm install
npm run build
```

The examples are TypeScript files under `examples/`. They can be executed with:

```bash
npm run examples:discover
npm run examples:read -- /$stat/time
```

## Publishing checklist

1. Update the version in `package.json`.
2. Ensure `npm run build` succeeds (`dist/` should contain `.js` + `.d.ts`).
3. Run the examples against a Wing console.
4. `npm publish --access public`

## License

MIT
