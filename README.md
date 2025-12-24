# Behringer Wing Library for TypeScript

A TypeScript/Node.js client for controlling the Behringer Wing digital mixer. It supports device discovery, property
reads/writes, schema inspection, and meter streaming.

Inspired by `libwing` (https://github.com/dannydulai/libwing), but this is an independent TypeScript implementation.

## Status

This is an early but functional port. The binary protocol encoder/decoder, keep-alive handling and
property map (over 78k entries) are implemented. More high-level helpers and tooling will be added
next.

## Installation

```bash
npm install behringer-wing
# or
pnpm add behringer-wing
```

Node.js 18+ is required because the library relies on the modern `net`/`dgram` APIs and Promise-based
infrastructure.

## Usage

### Discover consoles

`Wing.connect()` performs a discovery scan automatically if you do not provide a host/IP. Use
`Wing.scan()` when you want to list available consoles or pick a specific one.

```ts
import { Wing } from 'behringer-wing';

async function listConsoles() {
  const consoles = await Wing.scan();
  consoles.forEach((device) => {
    console.log(`${device.name} @ ${device.ip} (${device.model})`);
  });
}
```

### Read an OSC parameter

The request/response flow is asynchronous. After you call `requestNodeData`, the next frames you
receive via `read()` can include other events, so you need to filter by `nodeId` and keep reading
until you see the response you want.

```ts
import { Wing } from 'behringer-wing';

async function readProperty() {
  const nodeId = Wing.nameToId('/ch/1/fdr');
  if (nodeId === undefined) throw new Error('Unknown property');

  const wing = await Wing.connect();
  await wing.requestNodeData(nodeId);

  while (true) {
    const response = await wing.read();
    if (response.type === 'node-data' && response.id === nodeId) {
      console.log('CH 1 fader:', response.data.getFloat(), 'dB');
      break;
    }
  }

  await wing.close();
}
```

### Set an OSC parameter

```ts
import { Wing } from 'behringer-wing';

async function setChannelFader() {
  const nodeId = Wing.nameToId('/ch/1/fdr');
  if (nodeId === undefined) throw new Error('Unknown property');

  const wing = await Wing.connect();
  await wing.setFloat(nodeId, -10.0);
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

## API

All public exports are available from the package root:

```ts
import {
  Wing,
  NodeType,
  NodeUnit,
  WingNodeDef,
  WingNodeData,
  WingTreeEntry,
  MeterRequest,
  MeterRead,
  WingResponse,
  DiscoveryInfo,
} from 'behringer-wing';
```

### Wing

#### Static helpers

- `Wing.scan(stopOnFirst?: boolean, timeout?: number): Promise<DiscoveryInfo[]>`
  Broadcasts discovery probes and returns responding consoles.
- `Wing.connect(hostOrIp?: string): Promise<Wing>`
  Connects to a console (or the first discovered one).
- `Wing.nameToId(fullname: string): number | undefined`
  Converts a path to a node id using the bundled property map.
- `Wing.nameToDef(fullname: string): WingNodeDef | undefined`
  Returns the matching node definition.
- `Wing.idToDefs(id: number): Array<{ fullname: string; definition: WingNodeDef }> | undefined`
  Returns all known fullnames for a numeric id.

#### Instance methods

- `read(): Promise<WingResponse>`
  Waits for the next response frame.
- `getNodeTree(node: string | number): Promise<WingTreeEntry[]>`
  Reads a node and all of its child values.
- `getNodeTreeMap(node: string | number): Promise<Record<string, WingNodeData>>`
  Convenience map of `fullname -> data` for a subtree.
- `requestNodeDefinition(id: number): Promise<void>`
  Requests node metadata (read via `read()`).
- `requestNodeData(id: number): Promise<void>`
  Requests node data (read via `read()`).
- `setString(id: number, value: string): Promise<void>`
- `setFloat(id: number, value: number): Promise<void>`
- `setInt(id: number, value: number): Promise<void>`
  Write values to a node id.
- `requestMeter(meters: MeterRequest[]): Promise<number>`
  Starts a meter subscription and returns a meter id.
- `readMeters(): Promise<MeterRead>`
  Reads the next batch of meter values.
- `keepAlive(): Promise<void>`
  Sends a data keep-alive frame (normally automatic).
- `keepAliveMeters(): Promise<void>`
  Sends a meter keep-alive frame (normally automatic).
- `close(): Promise<void>`
  Closes sockets and timers.

### Types

- `DiscoveryInfo`: discovery metadata from `Wing.scan`.
- `WingResponse`: union of frames returned by `read()`.
- `MeterRequest`: request descriptor for `requestMeter`.
- `MeterRead`: meter values returned by `readMeters`.
- `WingTreeEntry`: entry returned by `getNodeTree`.
- `WingNodeDef`: node definition parser + helpers (`fromBytes`, `clone`, `toDescription`, `toJSON`).
- `WingNodeData`: typed container for node values (`withString/Float/Int`, `getString/Float/Int`, `isString/Float/Int`).
- `NodeType`, `NodeUnit`: enums used by `WingNodeDef`.

## Development

```bash
npm install
npm run build
```

The property map (`src/propmap-data.ts`) is generated from `data/propmap.jsonl`. Regenerate the TypeScript
module whenever the JSONL changes:

```bash
npm run generate:propmap
```

The examples are TypeScript files under `examples/`. They can be executed with:

```bash
npm run examples:discover
npm run examples:read -- /$stat/time
npm run examples:monitor
```

## Publishing checklist

1. Update the version in `package.json`.
2. Ensure `npm run build` succeeds (`dist/` should contain `.js` + `.d.ts`).
3. Run the examples against a Wing console.
4. `npm publish --access public`

## License

MIT
