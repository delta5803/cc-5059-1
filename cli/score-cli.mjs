#!/usr/bin/env node
// 辅助命令行：体检曲谱、查看段落与连接、离线运行情境序列。图形入口见 README（npm run serve）。
import { readFileSync } from 'node:fs';
import { SCORE } from '../src/score-data.js';
import { validateScore } from '../src/validate.js';
import { renderScenario } from '../src/render.js';
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
  default: {
    console.log(`段落配乐引擎 · 辅助命令行
用法: node cli/score-cli.mjs <命令>
  validate            体检曲谱与连接图
  sections            列出段落（调性/拍号/弱起/准备拍）
  links               列出声明连接与可行性
  run <file.json>     运行情境序列（{"start","until","requests":[{"t","mood"}]}）
  demo                运行内置示例情境
  --json              run/demo 输出完整事件 JSON
图形入口: npm run serve 后打开浏览器（见 README）`);
    process.exit(cmd ? 2 : 0);
  }
}
