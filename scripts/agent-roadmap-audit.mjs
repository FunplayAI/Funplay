import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowedPlanStatuses = new Set(['Completed', 'Superseded', 'Deferred']);
const routeAudits = [
  {
    label: 'Agent maturity roadmap',
    path: 'docs/agent-maturity-roadmap.md',
    idPattern: /^M\d+$/,
    statusIndex: 2,
    allowedStatuses: new Set(['Completed'])
  },
  {
    label: 'Agent architecture plan',
    path: 'docs/agent-architecture-improvement-plan.md',
    idPattern: /^P\d+-\d+$/,
    statusIndex: 2,
    allowedStatuses: allowedPlanStatuses
  },
  {
    label: 'Agent Core v2 roadmap',
    path: 'docs/agent-core-v2-roadmap.md',
    idPattern: /^AC\d+-\d+$/,
    statusIndex: 2,
    allowedStatuses: new Set(['Completed'])
  },
  {
    label: 'Skills v2 roadmap',
    path: 'docs/skills-v2-roadmap.md',
    idPattern: /^SK\d+-\d+$/,
    statusIndex: 2,
    allowedStatuses: new Set(['Completed'])
  },
  {
    label: 'Agent Platform v3 roadmap',
    path: 'docs/agent-platform-v3-roadmap.md',
    idPattern: /^C\d+-\d+$/,
    statusIndex: 1,
    allowedStatuses: new Set(['Completed'])
  },
  {
    label: 'Desktop UI improvement plan',
    path: 'docs/desktop-ui-improvement-plan.md',
    idPattern: /^U\d+-\d+$/,
    statusIndex: 2,
    allowedStatuses: new Set(['Completed', 'Deferred'])
  }
];

async function readDoc(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

function parseStatusRows(markdown, options) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > options.statusIndex && options.idPattern.test(cells[0]))
    .map((cells) => ({
      id: cells[0],
      title: cells[1],
      status: cells[options.statusIndex],
      cells
    }));
}

function fail(message, details = []) {
  console.error(message);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exitCode = 1;
}

const summaries = [];

for (const audit of routeAudits) {
  const markdown = await readDoc(audit.path);
  const rows = parseStatusRows(markdown, audit);
  const openRows = rows.filter((row) => !audit.allowedStatuses.has(row.status));

  if (rows.length === 0) {
    fail(`${audit.label} audit failed: no matching rows found in ${audit.path}.`);
    continue;
  }
  if (openRows.length > 0) {
    fail(
      `${audit.label} audit failed: open rows remain in ${audit.path}.`,
      openRows.map((row) => `${row.id} ${row.title}: ${row.status}`)
    );
  }

  summaries.push(`${audit.label}: ${rows.length} rows`);
}

if (!process.exitCode) {
  console.log(`Roadmap audit passed: ${summaries.join('; ')}.`);
}
