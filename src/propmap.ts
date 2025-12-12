import {
  FloatEnumItem,
  NodeType,
  NodeUnit,
  StringEnumItem,
  WingNodeDef,
} from './types';
import { PROP_MAP_LINES } from './propmap-data';

interface PropMapEntry {
  fullname: string;
  id: number;
  name?: string;
  longname?: string;
  type: string;
  unit?: string;
  maxfloat?: number | null;
  minfloat?: number | null;
  steps?: number | null;
  maxint?: number | null;
  minint?: number | null;
  maxstringlen?: number | null;
  items?: Array<{ item: string | number; longitem?: string }>;
}

let loaded = false;
const nameToDef = new Map<string, WingNodeDef>();
const idToNames = new Map<number, string[]>();

function toNodeType(value: string): NodeType {
  const normalized = value.toLowerCase();
  switch (normalized) {
    case 'linear float':
      return NodeType.LinearFloat;
    case 'log float':
      return NodeType.LogarithmicFloat;
    case 'fader level':
      return NodeType.FaderLevel;
    case 'integer':
      return NodeType.Integer;
    case 'string':
      return NodeType.String;
    case 'string enum':
      return NodeType.StringEnum;
    case 'float enum':
      return NodeType.FloatEnum;
    default:
      return NodeType.Node;
  }
}

function toNodeUnit(value?: string): NodeUnit {
  if (!value) return NodeUnit.None;
  switch (value.toLowerCase()) {
    case 'db':
      return NodeUnit.Db;
    case '%':
      return NodeUnit.Percent;
    case 'ms':
      return NodeUnit.Milliseconds;
    case 'hz':
      return NodeUnit.Hertz;
    case 'm':
    case 'meters':
      return NodeUnit.Meters;
    case 's':
    case 'sec':
    case 'seconds':
      return NodeUnit.Seconds;
    case 'oct':
    case 'octaves':
      return NodeUnit.Octaves;
    default:
      return NodeUnit.None;
  }
}

function convertEntry(entry: PropMapEntry): WingNodeDef {
  const nodeType = toNodeType(entry.type);
  let stringEnum: StringEnumItem[] | undefined;
  let floatEnum: FloatEnumItem[] | undefined;
  if (nodeType === NodeType.StringEnum && entry.items) {
    stringEnum = entry.items.map((item) => ({
      item: String(item.item),
      longItem: item.longitem,
    }));
  } else if (nodeType === NodeType.FloatEnum && entry.items) {
    floatEnum = entry.items.map((item) => ({
      item: typeof item.item === 'number' ? item.item : Number(item.item),
      longItem: item.longitem,
    }));
  }

  return new WingNodeDef(
    entry.id,
    0,
    0,
    entry.name ?? '',
    entry.longname ?? '',
    nodeType,
    toNodeUnit(entry.unit),
    false,
    entry.minfloat ?? undefined,
    entry.maxfloat ?? undefined,
    entry.steps ?? undefined,
    entry.minint ?? undefined,
    entry.maxint ?? undefined,
    entry.maxstringlen ?? undefined,
    stringEnum,
    floatEnum,
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  for (const line of PROP_MAP_LINES) {
    const parsed: PropMapEntry = JSON.parse(line);
    const def = convertEntry(parsed);
    nameToDef.set(parsed.fullname, def);
    const ids = idToNames.get(parsed.id) ?? [];
    ids.push(parsed.fullname);
    idToNames.set(parsed.id, ids);
  }
  loaded = true;
}

export function getNameToId(fullname: string): number | undefined {
  ensureLoaded();
  return nameToDef.get(fullname)?.id;
}

export function getNameToDef(fullname: string): WingNodeDef | undefined {
  ensureLoaded();
  const def = nameToDef.get(fullname);
  return def?.clone();
}

export function getIdToDefs(id: number): Array<{ fullname: string; definition: WingNodeDef }> | undefined {
  ensureLoaded();
  const names = idToNames.get(id);
  if (!names || names.length === 0) return undefined;
  return names.map((name) => {
    const def = nameToDef.get(name);
    if (!def) {
      throw new Error(`Missing definition for ${name}`);
    }
    return { fullname: name, definition: def.clone() };
  });
}
