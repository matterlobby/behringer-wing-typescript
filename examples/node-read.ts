

import { Wing, WingNodeDef, WingTreeEntry } from '../src';

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

    const fullnames = new Map<number, string>();
    fullnames.set(nodeId, nodePath);
    const definitions = new Map<number, WingNodeDef>();
    const entryById = new Map<number, WingTreeEntry>();
    const failedDefinitionIds = new Set<number>();
    const resolvedViaDefinition = new Set<number>();
    for (const entry of entries) {
      entryById.set(entry.id, entry);
      if (entry.fullname) {
        fullnames.set(entry.id, entry.fullname);
      }
      if (entry.definition) {
        definitions.set(entry.id, entry.definition);
      }
    }

    const displayCount = Math.min(entries.length, 100);
    for (let index = 0; index < displayCount; index += 1) {
      const entry = entries[index];
      if (!entry.fullname && !failedDefinitionIds.has(entry.id)) {
        try {
          await populateFullname(
            wing,
            entry,
            entryById,
            fullnames,
            definitions,
            failedDefinitionIds,
            resolvedViaDefinition,
          );
        } catch (err) {
          failedDefinitionIds.add(entry.id);
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`Could not resolve fullname for ${entry.id}: ${message}`);
        }
      }

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

      const fullname =
        entry.fullname ?? entry.definition?.longName ?? entry.definition?.name ?? '(unknown)';
      const resolutionHint = resolvedViaDefinition.has(entry.id) ? ' [definition fetched]' : '';
      console.log(`#${index + 1} ${fullname} (${entry.id}) => ${valuePreview}${resolutionHint}`);
    }
  } finally {
    await wing.close();
  }
}

async function populateFullname(
  wing: Wing,
  entry: WingTreeEntry,
  entryById: Map<number, WingTreeEntry>,
  fullnames: Map<number, string>,
  definitions: Map<number, WingNodeDef>,
  failedDefinitions: Set<number>,
  resolvedViaDefinition: Set<number>,
): Promise<void> {
  if (entry.fullname) {
    fullnames.set(entry.id, entry.fullname);
    return;
  }
  if (failedDefinitions.has(entry.id)) {
    return;
  }

  let definition: WingNodeDef | undefined;
  try {
    definition = await resolveDefinition(wing, entry.id, definitions);
  } catch (err) {
    failedDefinitions.add(entry.id);
    throw err;
  }
  if (!definition) {
    failedDefinitions.add(entry.id);
    return;
  }
  entry.definition = definition;
  definitions.set(entry.id, definition);

  const parentFullname = await resolveFullnameById(
    wing,
    definition.parentId,
    entryById,
    fullnames,
    definitions,
    failedDefinitions,
    resolvedViaDefinition,
  );
  const segment = definition.longName || definition.name || String(entry.id);
  entry.fullname = parentFullname ? `${parentFullname}/${segment}` : `/${segment}`;
  fullnames.set(entry.id, entry.fullname);
  resolvedViaDefinition.add(entry.id);
}

async function resolveFullnameById(
  wing: Wing,
  id: number,
  entryById: Map<number, WingTreeEntry>,
  fullnames: Map<number, string>,
  definitions: Map<number, WingNodeDef>,
  failedDefinitions: Set<number>,
  resolvedViaDefinition: Set<number>,
): Promise<string | undefined> {
  if (id === 0) {
    fullnames.set(0, '');
    return '';
  }
  if (fullnames.has(id)) {
    return fullnames.get(id);
  }

  const entry = entryById.get(id);
  if (entry) {
    await populateFullname(
      wing,
      entry,
      entryById,
      fullnames,
      definitions,
      failedDefinitions,
      resolvedViaDefinition,
    );
    return entry.fullname;
  }

  let definition: WingNodeDef | undefined;
  try {
    definition = await resolveDefinition(wing, id, definitions);
  } catch (err) {
    failedDefinitions.add(id);
    throw err;
  }
  if (!definition) {
    failedDefinitions.add(id);
    return undefined;
  }
  definitions.set(id, definition);

  const parentFullname = await resolveFullnameById(
    wing,
    definition.parentId,
    entryById,
    fullnames,
    definitions,
    failedDefinitions,
    resolvedViaDefinition,
  );
  const segment = definition.longName || definition.name || String(id);
  const fullname = parentFullname ? `${parentFullname}/${segment}` : `/${segment}`;
  fullnames.set(id, fullname);
  resolvedViaDefinition.add(id);
  return fullname;
}

async function resolveDefinition(
  wing: Wing,
  id: number,
  definitions: Map<number, WingNodeDef>,
): Promise<WingNodeDef | undefined> {
  const cached = definitions.get(id);
  if (cached) {
    return cached;
  }
  const definition = await requestDefinition(wing, id);
  if (definition) {
    definitions.set(id, definition);
  }
  return definition;
}

async function requestDefinition(wing: Wing, id: number): Promise<WingNodeDef | undefined> {
  await wing.requestNodeDefinition(id);
  let definition: WingNodeDef | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await wing.read();
    if (response.type === 'node-def' && response.definition.id === id) {
      definition = response.definition;
    } else if (response.type === 'request-end') {
      return definition;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
