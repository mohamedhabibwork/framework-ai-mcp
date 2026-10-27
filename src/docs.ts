import { readdirSync, readFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import { frameworkPaths } from './cli';

/** Repository files an AI agent may read through docs tools and resources. */
const DOC_SOURCES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'framwork.md', 'folder.md'];

export interface DocFile {
  /** Workspace-relative path, used as the resource/doc identifier. */
  readonly path: string;
  readonly title: string;
}

export interface DocMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

let docIndex: DocFile[] | undefined;

/** All readable documentation, computed from disk so new guides appear automatically. */
export function listDocs(): DocFile[] {
  if (docIndex) return docIndex;
  const { root } = frameworkPaths();
  const files: DocFile[] = [];
  const docsDir = join(root, 'docs');
  if (readdirSync(root, { withFileTypes: true }).some((entry) => entry.name === 'docs')) {
    for (const entry of readdirSync(docsDir)) {
      if (entry.endsWith('.md')) files.push({ path: `docs/${entry}`, title: entry.replace(/\.md$/, '') });
    }
  }
  for (const name of DOC_SOURCES) {
    if (readdirSync(root, { withFileTypes: true }).some((entry) => entry.name === name)) {
      files.push({ path: name, title: name.replace(/\.md$/, '') });
    }
  }
  docIndex = files.sort((a, b) => a.path.localeCompare(b.path));
  return docIndex;
}

function resolveDocPath(path: string): string {
  const { root } = frameworkPaths();
  const cleaned = normalize(path).replace(/^([.][/\\])+/, '');
  const absolute = resolve(root, cleaned);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || resolve(root, rel) !== absolute) {
    throw new Error(`Path escapes the workspace: ${path}`);
  }
  const allowed = listDocs().some((doc) => doc.path === rel.split('\\').join('/'));
  if (!allowed) {
    throw new Error(`Unknown document "${rel}". Call docs_list for the readable set.`);
  }
  return absolute;
}

/** Reads one whitelisted documentation file; throws on traversal or unknown paths. */
export function readDoc(path: string): string {
  return readFileSync(resolveDocPath(path), 'utf8');
}

/** Case-insensitive line search across every readable document. */
export function searchDocs(query: string, limit = 20): DocMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const { root } = frameworkPaths();
  const matches: DocMatch[] = [];
  for (const doc of listDocs()) {
    const lines = readFileSync(resolve(root, doc.path), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.toLowerCase().includes(needle)) {
        if (matches.length >= limit) return matches;
        matches.push({ path: doc.path, line: i + 1, text: line.trim().slice(0, 240) });
      }
    }
  }
  return matches;
}
