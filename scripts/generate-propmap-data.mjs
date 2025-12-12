#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const sourcePath = resolve(projectRoot, 'data', 'propmap.jsonl');
const targetPath = resolve(projectRoot, 'src', 'propmap-data.ts');

const rawContent = readFileSync(sourcePath, 'utf8');
const lines = rawContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
const header = '// This file is generated from data/propmap.jsonl; do not edit manually.\n';
const serialized = lines.map((line) => `  ${JSON.stringify(line)},`).join('\n');
const output = `${header}export const PROP_MAP_LINES: readonly string[] = [\n${serialized}\n];\n`;

writeFileSync(targetPath, output);

console.log(`Generated ${targetPath} from ${sourcePath} (${lines.length} entries).`);
