// Write a comprehensive baseline report from what we observed.
import { writeReport } from '../lib/report.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dirname, '..', 'baseline');

// Read the most recent T1T3 report
const t1t3 = JSON.parse(readFileSync(join(REPORT_DIR, 'T1T3-baseline.json'), 'utf8'));

// DB scene read by the agent (above MCP call) — hardcode the relevant parts
const dbScene = {
  // Two freedraw elements found in the saved scene
  elements: [
    {
      id: 'sKOjT5roFmrPRMfs-d62W',
      type: 'freedraw',
      points: [[0,0],[230,61],[224,61],[212,61],[209,61]],
      width: 230, height: 61,
      version: 6, versionNonce: 2010306884,
      x: 424.16, y: 4.27,
    },
    {
      id: 'Hp_Xe3M3BQYpKydZJ_6QI',
      type: 'freedraw',
      points: [[0,0],[6,9.7354736328125]],
      width: 6, height: 9.74,
      version: 3, versionNonce: 1832043588,
      x: 424.16, y: 204.27,
    },
  ],
  savedAt: '2026-06-29T16:41:54.560Z',
  // Dots in the saved scene
  dots: [
    {
      id: 'Hp_Xe3M3BQYpKydZJ_6QI',
      type: 'freedraw',
      points: 2,  // 2 points but width 6, height 9.7 → still a tiny line, not a single dot
      w: 6, h: 9.74,
    },
  ],
};

const report = {
  baseline_captured_at: new Date().toISOString(),
  // T1 result: scene has all strokes in memory
  T1: {
    inMemory: {
      elementCount: t1t3.after.count,
      maxVersion: t1t3.after.maxV,
      newElements: t1t3.newElements,
    },
    persisted: {
      elementCount: dbScene.elements.length,
      maxVersion: Math.max(...dbScene.elements.map((e) => e.version)),
      elements: dbScene.elements,
    },
    T1_pass: t1t3.after.count === dbScene.elements.length, // FAIL: 4 in memory, 2 in DB
  },
  // T3 result: dots in saved scene?
  T3: {
    savedDots: dbScene.dots,
    // The saved scene has elements with version 3-6 and 2-5 points — the
    // mid-stroke intermediate state. These are not technically "dots" (they
    // have 2+ points and non-zero size), but they are clearly truncated
    // versions of strokes that have 26-44 points in memory.
    T3_pass: dbScene.dots.length === 0, // STRICT pass would be 0 dots; loose is "no zero-size elements"
  },
  // Bug 1 evidence: save path doesn't filter degenerate freedraws
  bug1_evidence: {
    inMemoryStroke1Points: 44,
    savedStroke1Points: 5,
    inMemoryStroke2Points: 26,
    savedStroke2Points: 2,
    savedVersionVsInMemory: { saved: 6, inMemory: 45 },
    interpretation: 'Autosave fires mid-stroke, captures intermediate state. The v0.5.3 fix filters degenerate freedraws at BROADCAST level only, not at SAVE level.',
  },
  // Diag log summary
  diags: t1t3.diags,
};

writeFileSync(join(REPORT_DIR, 'BASELINE-line-dot.json'), JSON.stringify(report, null, 2));
console.log('BASELINE REPORT:');
console.log(JSON.stringify(report, null, 2));
