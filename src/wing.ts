import net, { AddressInfo } from 'node:net';
import dgram from 'node:dgram';
import { Buffer } from 'node:buffer';
import { WingNodeData, WingNodeDef, WingTreeEntry } from './types';
import { getIdToDefs, getNameToDef, getNameToId } from './propmap';

const DATA_KEEP_ALIVE_MS = 7_000;
const METERS_KEEP_ALIVE_MS = 3_000;

/**
 * A single console that responded to discovery.
 */
export interface DiscoveryInfo {
  ip: string;
  name: string;
  model: string;
  serial: string;
  firmware: string;
}

/**
 * Possible responses emitted by {@link Wing.read}.
 */
export type WingResponse =
  | { type: 'request-end' }
  | { type: 'node-def'; definition: WingNodeDef }
  | { type: 'node-data'; id: number; data: WingNodeData };

/**
 * Meter selectors that require an accompanying numeric index.
 */
type MeterKindWithIndex =
  | 'channel'
  | 'aux'
  | 'bus'
  | 'main'
  | 'matrix'
  | 'dca'
  | 'fx'
  | 'source'
  | 'output'
  | 'channel2'
  | 'aux2'
  | 'bus2'
  | 'main2'
  | 'matrix2';

/**
 * All supported meter selectors, including index-free variants.
 */
type MeterKind = MeterKindWithIndex | 'monitor' | 'rta';

/**
 * Describes which meters to subscribe to in {@link Wing.requestMeter}.
 */
export type MeterRequest =
  | { kind: MeterKindWithIndex; index: number }
  | { kind: 'monitor' | 'rta' };

/**
 * Raw meter data payload returned from {@link Wing.readMeters}.
 */
export interface MeterRead {
  meterId: number;
  values: number[];
}

/**
 * Promise handlers waiting for the next decoded byte.
 */
type ByteWaiter = { resolve: (value: number) => void; reject: (err: Error) => void };

/**
 * Tracks UDP socket details and pending meter reads.
 */
interface MeterState {
  socket: dgram.Socket;
  port: number;
  nextMeterId: number;
  activeIds: Set<number>;
  waiters: Array<(read: MeterRead) => void>;
  queue: MeterRead[];
}

/**
 * High-level client for Behringer Wing mixers covering discovery, IO and data helpers.
 */
export class Wing {
  private readonly socket: net.Socket;
  private readonly byteQueue: number[] = [];
  private readonly byteWaiters: ByteWaiter[] = [];
  private rxEsc = false;
  private rxCurrentChannel = -1;
  private rxHasInPipe?: number;
  private currentNodeId = 0;
  private destroyed = false;
  private lastError?: Error;
  private dataKeepAlive?: NodeJS.Timeout;
  private meterKeepAlive?: NodeJS.Timeout;
  private meterState?: MeterState;

  /**
   * Internal constructor, use {@link connect}. Sets up socket listeners and keep-alives.
   */
  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => this.onChunk(chunk));
    this.socket.on('error', (err) => this.onError(err));
    this.socket.on('close', () => this.onClose());
    this.dataKeepAlive = setInterval(() => this.sendKeepAlive(), DATA_KEEP_ALIVE_MS);
  }

  /**
   * Broadcasts a discovery probe and returns unique Wing consoles that respond.
   */
  public static async scan(stopOnFirst = false, timeout = 500): Promise<DiscoveryInfo[]> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const results: DiscoveryInfo[] = [];
      const seen = new Set<string>();
      let attempts = 0;
      const maxAttempts = 10;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        // Ensure timers and sockets do not linger if we exit early.
        if (timer) clearInterval(timer);
        socket.close();
      };

      socket.on('message', (msg) => {
        const response = msg.toString('utf8').trim();
        const tokens = response.split(',');
        if (tokens.length >= 6 && tokens[0] === 'WING') {
          const info: DiscoveryInfo = {
            ip: tokens[1],
            name: tokens[2],
            model: tokens[3],
            serial: tokens[4],
            firmware: tokens[5],
          };
          const key = `${info.ip}-${info.serial}`;
          if (seen.has(key)) {
            return;
          }
          seen.add(key);
          results.push(info);
          if (stopOnFirst) {
            cleanup();
            resolve(results);
          }
        }
      });

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      const sendProbe = () => {
        attempts += 1;
        socket.send(Buffer.from('WING?'), 2222, '255.255.255.255', (err) => {
          if (err) {
            cleanup();
            reject(err);
          }
        });
        if (attempts >= maxAttempts && !stopOnFirst) {
          cleanup();
          resolve(results);
        }
      };

      socket.bind({ address: '0.0.0.0', port: 0 }, () => {
        socket.setBroadcast(true);
        sendProbe();
        timer = setInterval(() => {
          if (stopOnFirst && results.length > 0) {
            cleanup();
            resolve(results);
            return;
          }
          if (attempts >= maxAttempts) {
            cleanup();
            resolve(results);
            return;
          }
          sendProbe();
        }, timeout);
      });
    });
  }

  /**
   * Connects to the first discovered mixer or the provided host/IP and performs the handshake.
   */
  public static async connect(hostOrIp?: string): Promise<Wing> {
    let target = hostOrIp;
    if (!target) {
      const devices = await Wing.scan(true);
      if (!devices.length) {
        throw new Error('No Wing consoles discovered');
      }
      target = devices[0].ip;
    }
    const socket = await Wing.openSocket(target);
    // Constructor is private: only allow instances that went through the handshake.
    return new Wing(socket);
  }

  /**
   * Opens the TCP socket and writes the initial handshake bytes.
   */
  private static openSocket(host: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port: 2222 }, () => {
        socket.setNoDelay(true);
        socket.write(Buffer.from([0xdf, 0xd1]));
        resolve(socket);
      });
      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  /**
   * Reads and decodes the next response from the console, blocking until one arrives.
   */
  public async read(): Promise<WingResponse> {
    this.assertAlive();
    const raw: number[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Interpret the stream byte-by-byte; each command dictates the following payload.
      const [, cmd] = await this.decodeNext(raw);
      if (cmd <= 0x3f) {
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withInt(cmd) };
      }
      if (cmd <= 0x7f) {
        continue;
      }
      if (cmd <= 0xbf) {
        const len = cmd - 0x80 + 1;
        const value = await this.readString(len, raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withString(value) };
      }
      if (cmd <= 0xcf) {
        const len = cmd - 0xc0 + 1;
        const value = await this.readString(len, raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withString(value) };
      }
      if (cmd === 0xd0) {
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withString('') };
      }
      if (cmd === 0xd1) {
        const len = (await this.readU8(raw)) + 1;
        const value = await this.readString(len, raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withString(value) };
      }
      if (cmd === 0xd2) {
        await this.readU16(raw);
        continue;
      }
      if (cmd === 0xd3) {
        const value = await this.readI16(raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withInt(value) };
      }
      if (cmd === 0xd4) {
        const value = await this.readI32(raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withInt(value) };
      }
      if (cmd === 0xd5 || cmd === 0xd6) {
        const value = await this.readFloat(raw);
        return { type: 'node-data', id: this.currentNodeId, data: WingNodeData.withFloat(value) };
      }
      if (cmd === 0xd7) {
        this.currentNodeId = await this.readI32(raw);
        continue;
      }
      if (cmd === 0xd8) {
        continue;
      }
      if (cmd === 0xd9) {
        await this.readI8(raw);
        continue;
      }
      if (cmd === 0xda || cmd === 0xdb || cmd === 0xdc || cmd === 0xdd) {
        continue;
      }
      if (cmd === 0xde) {
        return { type: 'request-end' };
      }
      if (cmd === 0xdf) {
        const defLen = await this.readU16(raw);
        if (defLen === 0) {
          await this.readU32(raw);
        }
        raw.length = 0;
        for (let i = 0; i < defLen; i += 1) {
          await this.decodeNext(raw);
        }
        const definition = WingNodeDef.fromBytes(Buffer.from(raw));
        return { type: 'node-def', definition };
      }
    }
  }

  /**
   * Requests all child node values of the provided node path or ID in a single stream.
   */
  public async getNodeTree(node: string | number): Promise<WingTreeEntry[]> {
    const resolvedId = typeof node === 'number' ? node : Wing.nameToId(node);
    if (resolvedId === undefined) {
      throw new Error(`Unknown node ${node}`);
    }

    await this.requestNodeData(resolvedId);
    const entries: WingTreeEntry[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.read();
      if (response.type === 'request-end') {
        return entries;
      }
      if (response.type !== 'node-data') {
        continue;
      }
      const defs = Wing.idToDefs(response.id);
      const fullname = defs && defs.length > 0 ? defs[0].fullname : undefined;
      const definition = defs && defs.length > 0 ? defs[0].definition : undefined;
      entries.push({
        id: response.id,
        fullname,
        definition,
        data: response.data,
      });
    }
  }

  /**
   * Convenience helper returning a map indexed by fullname for known tree entries.
   */
  public async getNodeTreeMap(node: string | number): Promise<Record<string, WingNodeData>> {
    const entries = await this.getNodeTree(node);
    const result: Record<string, WingNodeData> = {};
    for (const entry of entries) {
      if (entry.fullname) {
        result[entry.fullname] = entry.data;
      }
    }
    return result;
  }

  /**
   * Requests the definition metadata of a node ID; results arrive via {@link read}.
   */
  public async requestNodeDefinition(id: number): Promise<void> {
    const buffer = this.buildIdCommand(id, 0xdd);
    await this.write(buffer);
  }

  /**
   * Requests the current value of a node ID; results arrive via {@link read}.
   */
  public async requestNodeData(id: number): Promise<void> {
    const buffer = this.buildIdCommand(id, 0xdc);
    await this.write(buffer);
  }

  /**
   * Writes a string property to the mixer, handling the protocol framing details.
   */
  public async setString(id: number, value: string): Promise<void> {
    const buffer = this.buildIdCommand(id);
    const payload: number[] = [];
    if (!value.length) {
      payload.push(0xd0);
    } else if (value.length <= 64) {
      payload.push(0x7f + value.length);
    } else if (value.length <= 256) {
      payload.push(0xd1);
      payload.push(value.length - 1);
    } else {
      throw new Error('String too long for Wing protocol');
    }
    for (const byte of Buffer.from(value, 'utf8')) {
      payload.push(byte);
    }
    await this.write(Buffer.concat([buffer, Buffer.from(payload)]));
  }

  /**
   * Writes a float property in big-endian IEEE754 encoding.
   */
  public async setFloat(id: number, value: number): Promise<void> {
    const buffer = this.buildIdCommand(id, 0xd5);
    const payload = Buffer.alloc(4);
    payload.writeFloatBE(value, 0);
    await this.write(Buffer.concat([buffer, payload]));
  }

  /**
   * Writes an integer property using the most compact encoding supported.
   */
  public async setInt(id: number, value: number): Promise<void> {
    const buffer = this.buildIdCommand(id);
    const payload: number[] = [];
    if (value >= 0 && value <= 0x3f) {
      payload.push(value);
    } else if (value >= -32768 && value <= 32767) {
      payload.push(0xd3);
      const tmp = Buffer.alloc(2);
      tmp.writeInt16BE(value, 0);
      payload.push(...tmp);
    } else {
      payload.push(0xd4);
      const tmp = Buffer.alloc(4);
      tmp.writeInt32BE(value, 0);
      payload.push(...tmp);
    }
    await this.write(Buffer.concat([buffer, Buffer.from(payload)]));
  }

  /**
   * Subscribes to meter streams and returns the meter request ID used in {@link readMeters}.
   */
  public async requestMeter(meters: MeterRequest[]): Promise<number> {
    const state = await this.ensureMeterState();
    state.nextMeterId += 1;
    const meterId = state.nextMeterId;
    state.activeIds.add(meterId);
    const header: number[] = [
      0xdf,
      0xd3,
      0xd3,
      (state.port >> 8) & 0xff,
      state.port & 0xff,
      0xd4,
      (meterId >> 8) & 0xff,
      meterId & 0xff,
      (state.port >> 8) & 0xff,
      state.port & 0xff,
      0xdc,
    ];
    const payload: number[] = [];
    for (const meter of meters) {
        const [code, needsIndex] = this.meterCode(meter.kind);
        payload.push(code);
        if (needsIndex) {
          if (!('index' in meter)) {
            throw new Error(`Meter ${meter.kind} requires index`);
          }
          // Protocol encodes the requested channel number directly after the type byte.
          payload.push(meter.index);
        }
      }
    const tail = [0xde, 0xdf, 0xd1];
    await this.write(Buffer.from([...header, ...payload, ...tail]));
    if (!this.meterKeepAlive) {
      // Keep-alives are required per active subscription to keep UDP data flowing.
      this.meterKeepAlive = setInterval(() => this.sendMeterKeepAlive(), METERS_KEEP_ALIVE_MS);
    }
    return meterId;
  }

  /**
   * Awaits the next batch of subscribed meter values, blocking until available.
   */
  public async readMeters(): Promise<MeterRead> {
    const state = await this.ensureMeterState();
    if (state.queue.length > 0) {
      return state.queue.shift()!;
    }
    return new Promise((resolve) => {
      state.waiters.push(resolve);
    });
  }

  /**
   * Sends a keep-alive frame manually; normally handled automatically.
   */
  public async keepAlive(): Promise<void> {
    await this.write(Buffer.from([0xdf, 0xd1]));
  }

  /**
   * Sends a keep-alive for meter subscriptions; normally handled automatically.
   */
  public async keepAliveMeters(): Promise<void> {
    this.sendMeterKeepAlive();
  }

  /**
   * Closes sockets and timers gracefully; safe to call multiple times.
   */
  public async close(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.dataKeepAlive) clearInterval(this.dataKeepAlive);
    if (this.meterKeepAlive) clearInterval(this.meterKeepAlive);
    if (this.meterState) {
      this.meterState.socket.close();
      this.meterState = undefined;
    }
    await new Promise<void>((resolve) => {
      this.socket.end(() => resolve());
    });
    this.socket.destroy();
  }

  /**
   * Converts a path-style fullname to its numeric node ID, or parses numbers directly.
   */
  public static nameToId(fullname: string): number | undefined {
    if (!fullname) return undefined;
    if (/^-?\d+$/.test(fullname)) {
      return Number(fullname);
    }
    return getNameToId(fullname);
  }

  /**
   * Returns a cloned node definition for the given fullname if it exists.
   */
  public static nameToDef(fullname: string): WingNodeDef | undefined {
    return getNameToDef(fullname);
  }

  /**
   * Provides all known fullnames and definitions matching a numeric node ID.
   */
  public static idToDefs(id: number): Array<{ fullname: string; definition: WingNodeDef }> | undefined {
    return getIdToDefs(id);
  }

  /**
   * Writes a raw buffer to the Wing socket and awaits completion.
   */
  private async write(buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(buffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Lazily creates the UDP socket for meter subscriptions and state tracking.
   */
  private async ensureMeterState(): Promise<MeterState> {
    if (this.meterState) {
      return this.meterState;
    }
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    socket.on('message', (msg) => this.onMeterData(msg));
    const address = socket.address() as AddressInfo;
    this.meterState = {
      socket,
      port: address.port,
      nextMeterId: 0,
      activeIds: new Set(),
      waiters: [],
      queue: [],
    };
    return this.meterState;
  }

  /**
   * Sends a keep-alive frame if the connection is still active.
   */
  private sendKeepAlive(): void {
    if (this.destroyed) return;
    this.socket.write(Buffer.from([0xdf, 0xd1]));
  }

  /**
   * Sends keep-alive frames for every active meter subscription.
   */
  private sendMeterKeepAlive(): void {
    if (!this.meterState || this.meterState.activeIds.size === 0) return;
    const { port } = this.meterState;
    for (const id of this.meterState.activeIds) {
      const buffer = Buffer.from([
        0xdf,
        0xd3,
        0xd4,
        (id >> 8) & 0xff,
        id & 0xff,
        (port >> 8) & 0xff,
        port & 0xff,
        0xdf,
        0xd1,
      ]);
      this.socket.write(buffer);
    }
  }

  /**
   * Parses UDP meter responses and resolves pending promises.
   */
  private onMeterData(msg: Buffer): void {
    if (!this.meterState) return;
    if (msg.length < 4) return;
    const meterId = msg.readUInt16BE(0);
    const values: number[] = [];
    for (let i = 4; i + 1 < msg.length; i += 2) {
      values.push(msg.readInt16BE(i));
    }
    const read: MeterRead = { meterId, values };
    if (this.meterState.waiters.length > 0) {
      const resolve = this.meterState.waiters.shift()!;
      resolve(read);
    } else {
      this.meterState.queue.push(read);
    }
  }

  /**
   * Maps meter kinds to their protocol codes and index requirements.
   */
  private meterCode(kind: MeterRequest['kind']): [number, boolean] {
    switch (kind) {
      case 'channel':
        return [0xa0, true];
      case 'aux':
        return [0xa1, true];
      case 'bus':
        return [0xa2, true];
      case 'main':
        return [0xa3, true];
      case 'matrix':
        return [0xa4, true];
      case 'dca':
        return [0xa5, true];
      case 'fx':
        return [0xa6, true];
      case 'source':
        return [0xa7, true];
      case 'output':
        return [0xa8, true];
      case 'monitor':
        return [0xa9, false];
      case 'rta':
        return [0xaa, false];
      case 'channel2':
        return [0xab, true];
      case 'aux2':
        return [0xac, true];
      case 'bus2':
        return [0xad, true];
      case 'main2':
        return [0xae, true];
      case 'matrix2':
        return [0xaf, true];
      default:
        throw new Error(`Unsupported meter kind: ${kind}`);
    }
  }

  /**
   * Decodes the next byte/value pair from the Wing stream, respecting escapes.
   */
  private async decodeNext(raw: number[]): Promise<[number, number]> {
    if (this.rxHasInPipe !== undefined) {
      const value = this.rxHasInPipe;
      this.rxHasInPipe = undefined;
      raw.push(value);
      return [this.rxCurrentChannel, value];
    }
    while (true) {
      // Maintain state machine mirroring Behringer's escaping rules.
      const byte = await this.readByte();
      if (!this.rxEsc) {
        if (byte === 0xdf) {
          this.rxEsc = true;
          continue;
        }
        raw.push(byte);
        return [this.rxCurrentChannel, byte];
      }
      if (byte === 0xdf) {
        this.rxEsc = false;
        raw.push(byte);
        return [this.rxCurrentChannel, byte];
      }
      this.rxEsc = false;
      if (byte === 0xde) {
        raw.push(0xdf);
        return [this.rxCurrentChannel, 0xdf];
      }
      if (byte >= 0xd0 && byte < 0xde) {
        this.rxCurrentChannel = byte - 0xd0;
        continue;
      }
      if (this.rxCurrentChannel >= 0) {
        this.rxHasInPipe = byte;
        raw.push(0xdf);
        return [this.rxCurrentChannel, 0xdf];
      }
      raw.push(byte);
      return [this.rxCurrentChannel, byte];
    }
  }

  /**
   * Awaits a single byte from the TCP socket buffer.
   */
  private readByte(): Promise<number> {
    if (this.byteQueue.length > 0) {
      return Promise.resolve(this.byteQueue.shift()!);
    }
    if (this.destroyed) {
      return Promise.reject(this.lastError ?? new Error('Wing connection closed'));
    }
    return new Promise((resolve, reject) => {
      this.byteWaiters.push({ resolve, reject });
    });
  }

  /**
   * Reads a UTF-8 string of the given length via repeated decode operations.
   */
  private async readString(length: number, raw: number[]): Promise<string> {
    const bytes: number[] = [];
    for (let i = 0; i < length; i += 1) {
      const [, value] = await this.decodeNext(raw);
      bytes.push(value);
    }
    return Buffer.from(bytes).toString('utf8');
  }

  /**
   * Reads an unsigned byte via {@link decodeNext}.
   */
  private async readU8(raw: number[]): Promise<number> {
    const [, value] = await this.decodeNext(raw);
    return value;
  }

  /**
   * Reads a big-endian unsigned 16-bit integer.
   */
  private async readU16(raw: number[]): Promise<number> {
    const high = await this.readU8(raw);
    const low = await this.readU8(raw);
    return (high << 8) | low;
  }

  /**
   * Reads a signed 16-bit integer in big-endian order.
   */
  private async readI16(raw: number[]): Promise<number> {
    const value = await this.readU16(raw);
    return value > 0x7fff ? value - 0x1_0000 : value;
  }

  /**
   * Reads an unsigned 32-bit integer.
   */
  private async readU32(raw: number[]): Promise<number> {
    const b1 = await this.readU8(raw);
    const b2 = await this.readU8(raw);
    const b3 = await this.readU8(raw);
    const b4 = await this.readU8(raw);
    return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
  }

  /**
   * Reads a signed 32-bit integer.
   */
  private async readI32(raw: number[]): Promise<number> {
    const value = await this.readU32(raw);
    return value > 0x7fffffff ? value - 0x1_0000_0000 : value;
  }

  /**
   * Reads a 32-bit IEEE754 float.
   */
  private async readFloat(raw: number[]): Promise<number> {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(await this.readU8(raw), 0);
    buffer.writeUInt8(await this.readU8(raw), 1);
    buffer.writeUInt8(await this.readU8(raw), 2);
    buffer.writeUInt8(await this.readU8(raw), 3);
    return buffer.readFloatBE(0);
  }

  /**
   * Reads a signed byte.
   */
  private async readI8(raw: number[]): Promise<number> {
    const [, value] = await this.decodeNext(raw);
    return value > 0x7f ? value - 0x100 : value;
  }

  /**
   * Formats a node ID request payload with optional suffix command.
   */
  private buildIdCommand(id: number, suffix?: number): Buffer {
    if (id === 0) {
      const bytes = suffix === 0xdd ? [0xda, 0xdd] : [0xda, 0xdc];
      return Buffer.from(bytes);
    }
    const buf: number[] = [0xd7];
    const tmp = Buffer.alloc(4);
    tmp.writeInt32BE(id, 0);
    for (const byte of tmp) {
      buf.push(byte);
      if (byte === 0xdf) buf.push(0xde);
    }
    if (suffix !== undefined) {
      buf.push(suffix);
    }
    return Buffer.from(buf);
  }

  /**
   * Handles incoming TCP data chunks, resolving any blocked readers.
   */
  private onChunk(chunk: Buffer): void {
    for (const byte of chunk.values()) {
      this.byteQueue.push(byte);
    }
    while (this.byteQueue.length && this.byteWaiters.length) {
      // Satisfy awaiting reads in FIFO order to preserve stream semantics.
      const waiter = this.byteWaiters.shift()!;
      waiter.resolve(this.byteQueue.shift()!);
    }
  }

  /**
   * Bubbles socket errors to pending readers.
   */
  private onError(err: Error): void {
    this.lastError = err;
    while (this.byteWaiters.length) {
      const waiter = this.byteWaiters.shift()!;
      waiter.reject(err);
    }
  }

  /**
   * Cleans up when the TCP socket closes, rejecting pending readers.
   */
  private onClose(): void {
    this.destroyed = true;
    if (this.dataKeepAlive) clearInterval(this.dataKeepAlive);
    if (this.meterKeepAlive) clearInterval(this.meterKeepAlive);
    while (this.byteWaiters.length) {
      const waiter = this.byteWaiters.shift()!;
      waiter.reject(this.lastError ?? new Error('Wing closed'));
    }
  }

  /**
   * Throws if the Wing instance has already been closed.
   */
  private assertAlive(): void {
    if (this.destroyed) {
      throw this.lastError ?? new Error('Wing is closed');
  }
}
}
