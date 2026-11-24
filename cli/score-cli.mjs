#!/usr/bin/env node
// 辅助命令行：体检曲谱、查看段落与连接、离线运行情境序列、过渡卡住诊断与双份乐谱导出。
// 图形入口见 README（npm run serve）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { SCORE } from '../src/score-data.js';
import { validateScore } from '../src/validate.js';
import { renderScenario, renderPickupVariants, scoreExport } from '../src/render.js';
import { diagnoseScenario, summarizeDiagnosis } from '../src/diagnosis.js';
import { DEMO_SCENARIO } from '../src/scenarios.js';
import { expandEdges, edgeKeyOk } from '../src/graph.js';
import { keyName, midiName } from '../src/theory.js';

const [, , cmd, ...rest] = process.argv;
const asJson = rest.includes('--json');
const args = rest.filter((a) => a !== '--json');

const KIND_NAMES = { theme: '主题', transition: '过渡', ending: '收束' };

function fmtSec(sec) {
  return `${sec.id}  ${sec.title}  [${KIND_NAMES[sec.kind]}]  ${keyName(sec.key)}  ${sec.meter.num}/${sec.meter.den}  ♩=${sec.tempo}  弱起${sec.pickupBeats}拍  准备${sec.prepareBeats}拍`;
}

function printResult(result) {
  console.log('\n== 段落序列（听闻路径） ==');
  for (const s of result.segments) {
    const sec = SCORE.sections[s.secId];
    console.log(`  第${String(s.startBeat).padStart(3)}拍  ${sec.title}（${KIND_NAMES[sec.kind]}）`);
  }
  console.log('\n== 过渡节奏（接点） ==');
  for (const j of result.joins) {
    console.log(`  第${j.atBeat}拍  ${SCORE.sections[j.from].title} → ${SCORE.sections[j.to].title}`);
  }
  console.log('\n== 调度日志 ==');
  for (const l of result.log) console.log(`  [第${l.t}拍] ${l.type.padEnd(9)} ${l.msg}`);
  console.log('\n== 校验 ==');
  if (result.violations.length === 0) console.log('  通过：计划路径与听闻一致，接点和声/弱起/延音/拍号均合法');
  for (const v of result.violations) console.log(`  违规: ${v}`);
  console.log(`\n事件数 ${result.events.length}，结束于第 ${result.frontier} 拍${result.done ? '（已收束）' : ''}`);
}

function loadScenario(argName) {
  if (!argName || argName === 'demo') return DEMO_SCENARIO;
  return JSON.parse(readFileSync(argName, 'utf8'));
}

function variantsSummary(v) {
  return {
    pickupNotes: v.pickupNotes, omitPickupNotes: v.omitPickupNotes,
    totalNotes: v.totalNotes, omitTotalNotes: v.omitTotalNotes,
  };
}

switch (cmd) {
  case 'validate': {
    const { errors, warnings } = validateScore(SCORE);
    for (const w of warnings) console.log(`警告: ${w}`);
    for (const e of errors) console.log(`错误: ${e}`);
    console.log(errors.length ? `共 ${errors.length} 个错误` : '曲谱与连接图体检通过');
    process.exit(errors.length ? 1 : 0);
    break;
  }
  case 'sections': {
    for (const sec of Object.values(SCORE.sections)) console.log(fmtSec(sec));
    break;
  }
  case 'links': {
    for (const e of expandEdges(SCORE)) {
      const ok = edgeKeyOk(SCORE, e);
      const via = e.via ? `（声明 ${e.via.from}→${e.via.to}${e.via.via ? `，经 ${e.via.via}` : ''}）` : '';
      console.log(`${ok ? '可行' : '不可行'}  ${e.from} -> ${e.to} ${via}`);
    }
    break;
  }
  case 'run':
  case 'demo': {
    let scenario;
    if (cmd === 'demo') {
      scenario = DEMO_SCENARIO;
    } else {
      if (!args[0]) {
        console.error('用法: node cli/score-cli.mjs run <scenario.json> [--json]');
        process.exit(2);
      }
      scenario = JSON.parse(readFileSync(args[0], 'utf8'));
    }
    const result = renderScenario(SCORE, scenario);
    if (asJson) {
      console.log(JSON.stringify({ events: result.events, harmony: result.harmony, segments: result.segments, joins: result.joins, violations: result.violations }, null, 1));
    } else {
      printResult(result);
    }
    process.exit(result.violations.length ? 1 : 0);
    break;
  }
  case 'diagnose': {
    const scenario = loadScenario(args[0]);
    const diag = diagnoseScenario(SCORE, scenario, { traceMax: Number(scenario.traceMax) || 256 });
    if (asJson) {
      console.log(JSON.stringify(diag, null, 1));
    } else {
      console.log(summarizeDiagnosis(diag, SCORE));
      if (!diag.ok) console.log(`\n诊断发现问题：复跑${diag.reproducible ? '一致' : '不一致'}、伪报 ${diag.falseReports.length}、状态丢失 ${diag.lostStates.length}、校验违规 ${diag.violations.length}`);
      else console.log('\n诊断通过：证据可复跑一致、无伪报、无状态丢失、校验无违规。');
    }
    process.exit(diag.ok ? 0 : 1);
    break;
  }
  case 'export': {
    const scenario = loadScenario(args[0]);
    const variants = renderPickupVariants(SCORE, scenario);
    const full = scoreExport(SCORE, variants.full, '完整弱起');
    const omit = scoreExport(SCORE, variants.omit, '省略弱起');
    const outDir = args[1] || '.';
    if (asJson) {
      console.log(JSON.stringify({ full, omit, summary: variantsSummary(variants) }, null, 1));
    } else {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(`${outDir}/score-full-pickup.json`, JSON.stringify(full, null, 1));
      writeFileSync(`${outDir}/score-omit-pickup.json`, JSON.stringify(omit, null, 1));
      console.log(`已导出两份乐谱到 ${outDir}/`);
      console.log(`  完整弱起：${full.pickupCount} 弱起音 / ${full.noteCount} 事件 / 违规 ${full.violations.length}`);
      console.log(`  省略弱起：${omit.pickupCount} 弱起音 / ${omit.noteCount} 事件 / 违规 ${omit.violations.length}`);
      const segFull = full.segments.map((s) => `${s.startBeat}:${s.secId}`).join(' → ');
      const segOmit = omit.segments.map((s) => `${s.startBeat}:${s.secId}`).join(' → ');
      console.log(`  段落一致：${segFull === segOmit ? '是' : '否'}（${segOmit}）`);
    }
    process.exit(full.violations.length || omit.violations.length ? 1 : 0);
    break;
  }
  default: {
    console.log(`段落配乐引擎 · 辅助命令行
用法: node cli/score-cli.mjs <命令>
  validate            体检曲谱与连接图
  sections            列出段落（调性/拍号/弱起/准备拍）
  links               列出声明连接与可行性
  run <file.json>     运行情境序列（{"start","until","requests":[{"t","mood"}]}）
  demo                运行内置示例情境；前面加无参数的 run 亦可
  diagnose [file]     过渡卡住诊断：证据链 / 边界归因 / 复跑一致性（无文件用内置示例）
  export [file] [dir] 导出两份乐谱：完整弱起 / 省略弱起（默认当前目录）
  --json              run/demo/diagnose/export 输出完整 JSON
图形入口: npm run serve 后打开浏览器（见 README）`);
    process.exit(cmd ? 2 : 0);
  }
}
