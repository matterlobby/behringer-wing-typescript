import { Buffer } from 'node:buffer';

/**
 * The data categories a Wing node can represent.
 */
export enum NodeType {
  Node = 0,
  LinearFloat = 1,
  LogarithmicFloat = 2,
  FaderLevel = 3,
  Integer = 4,
  StringEnum = 5,
  FloatEnum = 6,
  String = 7,
}

/**
 * Measurement units associated with certain numeric nodes.
 */
export enum NodeUnit {
  None = 0,
  Db = 1,
  Percent = 2,
  Milliseconds = 3,
  Hertz = 4,
  Meters = 5,
  Seconds = 6,
  Octaves = 7,
}

/**
 * Represents one selectable item of a string enumeration node.
 */
export interface StringEnumItem {
  item: string;
  longItem?: string;
}

/**
 * Represents one selectable item of a float enumeration node.
 */
export interface FloatEnumItem {
  item: number;
  longItem?: string;
}

/**
 * Immutable representation of a Wing property definition including type metadata and limits.
 */
export class WingNodeDef {
  constructor(
    public id: number,
    public parentId: number,
    public index: number,
    public name: string,
    public longName: string,
    public nodeType: NodeType,
    public unit: NodeUnit,
    public readOnly: boolean,
    public minFloat?: number,
    public maxFloat?: number,
    public steps?: number,
    public minInt?: number,
    public maxInt?: number,
    public maxStringLength?: number,
    public stringEnum?: StringEnumItem[],
    public floatEnum?: FloatEnumItem[],
    public raw: Buffer = Buffer.alloc(0),
  ) {}

  /**
   * Parses a raw Wing node-definition payload into a structured object.
   */
  public static fromBytes(raw: Buffer): WingNodeDef {
    let offset = 0;

    const readI32 = () => {
      const value = raw.readInt32BE(offset);
      offset += 4;
      return value;
    };
    const readU16 = () => {
      const value = raw.readUInt16BE(offset);
      offset += 2;
      return value;
    };
    const readF32 = () => {
      const value = raw.readFloatBE(offset);
      offset += 4;
      return value;
    };

    const parentId = readI32();
    const id = readI32();
    const index = readU16();

    const nameLen = raw.readUInt8(offset);
    offset += 1;
    const name = raw.subarray(offset, offset + nameLen).toString('utf8');
    offset += nameLen;

    const longNameLen = raw.readUInt8(offset);
    offset += 1;
    const longName = raw.subarray(offset, offset + longNameLen).toString('utf8');
    offset += longNameLen;

    const flags = readU16();
    const nodeType = WingNodeDef.typeFromFlags((flags >> 4) & 0x0f);
    const unit = WingNodeDef.unitFromFlags(flags & 0x0f);
    const readOnly = ((flags >> 9) & 0x01) !== 0;

    let minFloat: number | undefined;
    let maxFloat: number | undefined;
    let steps: number | undefined;
    let minInt: number | undefined;
    let maxInt: number | undefined;
    let maxStringLength: number | undefined;
    let stringEnum: StringEnumItem[] | undefined;
    let floatEnum: FloatEnumItem[] | undefined;

    switch (nodeType) {
      case NodeType.String: {
        maxStringLength = readU16();
        break;
      }
      case NodeType.LinearFloat:
      case NodeType.LogarithmicFloat:
      case NodeType.FaderLevel: {
        minFloat = readF32();
        maxFloat = readF32();
        steps = raw.readInt32BE(offset);
        offset += 4;
        break;
      }
      case NodeType.Integer: {
        minInt = raw.readInt32BE(offset);
        offset += 4;
        maxInt = raw.readInt32BE(offset);
        offset += 4;
        break;
      }
      case NodeType.StringEnum: {
        const count = readU16();
        stringEnum = [];
        for (let i = 0; i < count; i += 1) {
          const itemLen = raw.readUInt8(offset);
          offset += 1;
          const item = raw.subarray(offset, offset + itemLen).toString('utf8');
          offset += itemLen;
          const longItemLen = raw.readUInt8(offset);
          offset += 1;
          const longItem = raw.subarray(offset, offset + longItemLen).toString('utf8');
          offset += longItemLen;
          stringEnum.push({ item, longItem: longItem || undefined });
        }
        break;
      }
      case NodeType.FloatEnum: {
        const count = readU16();
        floatEnum = [];
        for (let i = 0; i < count; i += 1) {
          const item = readF32();
          const longItemLen = raw.readUInt8(offset);
          offset += 1;
          const longItem = raw.subarray(offset, offset + longItemLen).toString('utf8');
          offset += longItemLen;
          floatEnum.push({ item, longItem: longItem || undefined });
        }
        break;
      }
      default:
        break;
    }

    return new WingNodeDef(
      id,
      parentId,
      index,
      name,
      longName,
      nodeType,
      unit,
      readOnly,
      minFloat,
      maxFloat,
      steps,
      minInt,
      maxInt,
      maxStringLength,
      stringEnum,
      floatEnum,
      Buffer.from(raw),
    );
  }

  private static typeFromFlags(value: number): NodeType {
    switch (value) {
      case 1:
        return NodeType.LinearFloat;
      case 2:
        return NodeType.LogarithmicFloat;
      case 3:
        return NodeType.FaderLevel;
      case 4:
        return NodeType.Integer;
      case 5:
        return NodeType.StringEnum;
      case 6:
        return NodeType.FloatEnum;
      case 7:
        return NodeType.String;
      default:
        return NodeType.Node;
    }
  }

  private static unitFromFlags(value: number): NodeUnit {
    switch (value) {
      case 1:
        return NodeUnit.Db;
      case 2:
        return NodeUnit.Percent;
      case 3:
        return NodeUnit.Milliseconds;
      case 4:
        return NodeUnit.Hertz;
      case 5:
        return NodeUnit.Meters;
      case 6:
        return NodeUnit.Seconds;
      case 7:
        return NodeUnit.Octaves;
      default:
        return NodeUnit.None;
    }
  }

  /**
   * Returns a deep copy so callers can mutate without affecting the cache.
   */
  public clone(): WingNodeDef {
    return new WingNodeDef(
      this.id,
      this.parentId,
      this.index,
      this.name,
      this.longName,
      this.nodeType,
      this.unit,
      this.readOnly,
      this.minFloat,
      this.maxFloat,
      this.steps,
      this.minInt,
      this.maxInt,
      this.maxStringLength,
      this.stringEnum?.map((item) => ({ ...item })),
      this.floatEnum?.map((item) => ({ ...item })),
      Buffer.from(this.raw),
    );
  }

  /**
   * Generates a human-readable, multi-line description similar to the Rust tooling.
   */
  public toDescription(): string {
    const lines: string[] = [];
    lines.push(`Id:        ${this.id}`);
    lines.push(`Read-only: ${this.readOnly ? 'yes' : 'no'}`);
    if (this.index) {
      lines.push(`Index:     ${this.index}`);
    }
    if (this.name) {
      lines.push(`Name:      ${this.name}`);
    }
    if (this.longName) {
      lines.push(`Long Name: ${this.longName}`);
    }
    lines.push(`Type:      ${NodeType[this.nodeType].toLowerCase()}`);
    if (this.unit !== NodeUnit.None) {
      lines.push(`Unit:      ${NodeUnit[this.unit]}`);
    }
    if (
      this.nodeType === NodeType.LinearFloat ||
      this.nodeType === NodeType.LogarithmicFloat ||
      this.nodeType === NodeType.FaderLevel
    ) {
      if (this.minFloat !== undefined) lines.push(`Minimum:   ${this.minFloat}`);
      if (this.maxFloat !== undefined) lines.push(`Maximum:   ${this.maxFloat}`);
      if (this.steps !== undefined) lines.push(`Steps:     ${this.steps}`);
    } else if (this.nodeType === NodeType.Integer) {
      if (this.minInt !== undefined) lines.push(`Minimum:   ${this.minInt}`);
      if (this.maxInt !== undefined) lines.push(`Maximum:   ${this.maxInt}`);
    } else if (this.nodeType === NodeType.String) {
      if (this.maxStringLength !== undefined) lines.push(`MaxLength: ${this.maxStringLength}`);
    } else if (this.nodeType === NodeType.StringEnum && this.stringEnum) {
      lines.push('Items:');
      this.stringEnum.forEach((item, index) => {
        const prefix = index === 0 ? '     ' : '           ';
        const suffix = item.longItem ? ` (${item.longItem})` : '';
        lines.push(`${prefix}${item.item}${suffix}`);
      });
    } else if (this.nodeType === NodeType.FloatEnum && this.floatEnum) {
      lines.push('Items:');
      this.floatEnum.forEach((item, index) => {
        const prefix = index === 0 ? '     ' : '           ';
        const suffix = item.longItem ? ` (${item.longItem})` : '';
        lines.push(`${prefix}${item.item}${suffix}`);
      });
    }
    return lines.join('\n');
  }

  /**
   * Converts the node definition to a JSON-ready object for schemas or debugging.
   */
  public toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      id: this.id,
      type: NodeType[this.nodeType].toLowerCase(),
    };
    if (this.index) result.index = this.index;
    if (this.name) result.name = this.name;
    if (this.longName) result.longname = this.longName;
    if (this.unit !== NodeUnit.None) result.unit = NodeUnit[this.unit];
    if (this.readOnly) result.read_only = true;
    if (this.minFloat !== undefined) result.minfloat = this.minFloat;
    if (this.maxFloat !== undefined) result.maxfloat = this.maxFloat;
    if (this.steps !== undefined) result.steps = this.steps;
    if (this.minInt !== undefined) result.minint = this.minInt;
    if (this.maxInt !== undefined) result.maxint = this.maxInt;
    if (this.maxStringLength !== undefined) result.maxstringlen = this.maxStringLength;
    if (this.stringEnum) {
      result.items = this.stringEnum.map((item) => ({
        item: item.item,
        ...(item.longItem ? { longitem: item.longItem } : {}),
      }));
    }
    if (this.floatEnum) {
      result.items = this.floatEnum.map((item) => ({
        item: item.item,
        ...(item.longItem ? { longitem: item.longItem } : {}),
      }));
    }
    return result;
  }
}

/**
 * Container for a single property value returned from the Wing mixer.
 */
export class WingNodeData {
  private readonly stringValue?: string;
  private readonly floatValue?: number;
  private readonly intValue?: number;

  private constructor(opts: { stringValue?: string; floatValue?: number; intValue?: number }) {
    this.stringValue = opts.stringValue;
    this.floatValue = opts.floatValue;
    this.intValue = opts.intValue;
  }

  /**
   * Creates a data container holding a string value.
   */
  public static withString(value: string): WingNodeData {
    return new WingNodeData({ stringValue: value });
  }

  /**
   * Creates a data container holding a float value.
   */
  public static withFloat(value: number): WingNodeData {
    return new WingNodeData({ floatValue: value });
  }

  /**
   * Creates a data container holding an integer value.
   */
  public static withInt(value: number): WingNodeData {
    return new WingNodeData({ intValue: value });
  }

  /**
   * Returns the stored value as string, falling back to other primitives when needed.
   */
  public getString(): string {
    if (this.stringValue !== undefined) return this.stringValue;
    if (this.floatValue !== undefined) return this.floatValue.toString();
    if (this.intValue !== undefined) return this.intValue.toString();
    return '';
  }

  /**
   * Returns the stored value as float, coercing integers where necessary.
   */
  public getFloat(): number {
    if (this.floatValue !== undefined) return this.floatValue;
    if (this.intValue !== undefined) return this.intValue;
    return 0;
  }

  /**
   * Returns the stored value as integer, truncating floats when required.
   */
  public getInt(): number {
    if (this.intValue !== undefined) return this.intValue;
    if (this.floatValue !== undefined) return Math.trunc(this.floatValue);
    return 0;
  }

  /**
   * Indicates whether the payload contains a native string value.
   */
  public isString(): boolean {
    return this.stringValue !== undefined;
  }

  /**
   * Indicates whether the payload contains a native float value.
   */
  public isFloat(): boolean {
    return this.floatValue !== undefined;
  }

  /**
   * Indicates whether the payload contains a native integer value.
   */
  public isInt(): boolean {
    return this.intValue !== undefined;
  }
}
