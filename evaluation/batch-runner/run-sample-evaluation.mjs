#!/usr/bin/env node

/**
 * HelpFlow public sample runner.
 * Executes the published sample cases and records raw results only.
 * It does not score answers or change application settings.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const evaluationDir = path.resolve(scriptDir, "..");
const testFile = path.join(evaluationDir, "test-cases-sample.md");
const resultsDir = path.join(evaluationDir, "results");
const allowedEnvKeys = new Set(["DIFY_API_KEY", "DIFY_API_BASE_URL", "DIFY_USER"]);

async function loadLocalEnv() {
  const envPath = path.join(scriptDir, ".env");
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const separator = line.indexOf("=");
      const key = line.slice(0, separator).trim();
      const value = line
        .slice(separator + 1)
        .trim()
        .replace(/^("|')|("|')$/g, "");
      if (allowedEnvKeys.has(key) && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function parseCases() {
  const text = (await fs.readFile(testFile, "utf8")).replace(/^\uFEFF/, "");
  const cases = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!/^\| T\d{3} \|/.test(line)) continue;
    const columns = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());

    if (columns.length !== 4) {
      throw new Error(`测试表第 ${index + 1} 行应为 4 列`);
    }

    const [testId, scenario, originalQuestion, expectedPoints] = columns;
    const turns = originalQuestion
      .split(/<br\s*\/?>/i)
      .map((turn) => turn.trim().replace(/^第\s*\d+\s*轮[：:]\s*/, ""));

    if (turns.some((turn) => !turn)) {
      throw new Error(`${testId} 包含空轮次`);
    }
    cases.push({ testId, scenario, expectedPoints, turns });
  }

  if (cases.length === 0) throw new Error("没有解析到公开测试样例");
  const ids = cases.map((item) => item.testId);
  if (new Set(ids).size !== ids.length) throw new Error("测试样例包含重复 ID");
  return cases;
}

function parseArgs(argv) {
  const options = { dryRun: false, testId: "", timeoutMs: 180_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") options.dryRun = true;
    else if (item === "--id") options.testId = String(argv[++index] ?? "").toUpperCase();
    else if (item === "--timeout") options.timeoutMs = Number(argv[++index]) * 1000;
    else if (item === "--help" || item === "-h") {
      console.log("用法: node run-sample-evaluation.mjs [--id Txxx] [--timeout 秒] [--dry-run]");
      process.exit(0);
    } else {
      throw new Error(`未知参数：${item}`);
    }
  }
  if (options.testId && !/^T\d{3}$/.test(options.testId)) {
    throw new Error("--id 必须使用 Txxx 格式");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout 必须为正数");
  }
  return options;
}

function normalizeBaseUrl(value) {
  const base = value.trim().replace(/\/+$/, "").replace(/\/chat-messages$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("DIFY_API_BASE_URL 必须以 http:// 或 https:// 开头");
  }
  return base;
}

function redact(value, secret) {
  const text = String(value ?? "");
  return secret ? text.replaceAll(secret, "[REDACTED]") : text;
}

async function sendMessage({ baseUrl, apiKey, user, query, conversationId, timeoutMs }) {
  const response = await fetch(`${baseUrl}/chat-messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: {},
      query,
      response_mode: "blocking",
      conversation_id: conversationId,
      user,
      files: [],
      auto_generate_name: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${redact(body.slice(0, 500), apiKey)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("服务返回的内容不是有效 JSON");
  }
  return data;
}

function resultRow({ testCase, turnIndex, question, status, answer = "", conversationId = "", messageId = "", responseTimeMs = "", error = "" }) {
  return {
    test_id: testCase.testId,
    scenario: testCase.scenario,
    turn_index: turnIndex,
    turn_count: testCase.turns.length,
    user_question: question,
    expected_points: testCase.expectedPoints,
    ai_answer: answer,
    conversation_id: conversationId,
    message_id: messageId,
    execution_status: status,
    error_message: error,
    response_time_ms: responseTimeMs,
    executed_at_utc: new Date().toISOString(),
  };
}

async function executeCases(cases, settings) {
  const rows = [];

  for (const testCase of cases) {
    let conversationId = "";
    let previousTurnFailed = false;

    for (let index = 0; index < testCase.turns.length; index += 1) {
      const question = testCase.turns[index];
      const turnIndex = index + 1;
      console.log(`[${testCase.testId} ${turnIndex}/${testCase.turns.length}] ${question}`);

      if (previousTurnFailed) {
        rows.push(resultRow({
          testCase,
          turnIndex,
          question,
          status: "skipped",
          conversationId,
          error: "前序轮次失败，本轮未发送",
        }));
        continue;
      }

      const started = performance.now();
      try {
        const data = await sendMessage({
          ...settings,
          query: question,
          conversationId,
        });
        const returnedConversationId = String(data.conversation_id ?? "");
        if (!returnedConversationId) throw new Error("成功响应缺少 conversation_id");
        const elapsedMs = Math.round(performance.now() - started);

        rows.push(resultRow({
          testCase,
          turnIndex,
          question,
          status: "success",
          answer: String(data.answer ?? ""),
          conversationId: returnedConversationId,
          messageId: String(data.message_id ?? ""),
          responseTimeMs: elapsedMs,
        }));
        conversationId = returnedConversationId;
        console.log(`  -> success (${elapsedMs} ms)`);
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - started);
        const message = error.name === "TimeoutError"
          ? `请求超过 ${settings.timeoutMs / 1000} 秒`
          : redact(error.message, settings.apiKey);
        rows.push(resultRow({
          testCase,
          turnIndex,
          question,
          status: "failed",
          conversationId,
          responseTimeMs: elapsedMs,
          error: message,
        }));
        previousTurnFailed = testCase.turns.length > 1;
        console.error(`  -> failed: ${message}`);
      }
    }
  }
  return rows;
}

function escapeMarkdown(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

async function writeResults(rows) {
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(
    path.join(resultsDir, "sample-results.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
    "utf8",
  );

  const successCount = rows.filter((row) => row.execution_status === "success").length;
  const markdown = [
    "# HelpFlow 公开样例原始执行结果",
    "",
    "> 本文件仅记录执行结果，不包含自动评分。",
    "",
    `- 轮次总数：${rows.length}`,
    `- 执行成功：${successCount}`,
    `- 其他状态：${rows.length - successCount}`,
    "",
    "| 测试 ID | 轮次 | 用户问题 | AI 实际回答 | 状态 | 响应时间 ms | 错误信息 |",
    "| --- | ---: | --- | --- | --- | ---: | --- |",
    ...rows.map((row) => `| ${[
      row.test_id,
      `${row.turn_index}/${row.turn_count}`,
      row.user_question,
      row.ai_answer,
      row.execution_status,
      row.response_time_ms,
      row.error_message,
    ].map(escapeMarkdown).join(" | ")} |`),
    "",
  ].join("\n");

  await fs.writeFile(path.join(resultsDir, "sample-results.md"), markdown, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allCases = await parseCases();
  const selectedCases = options.testId
    ? allCases.filter((item) => item.testId === options.testId)
    : allCases;

  if (selectedCases.length === 0) throw new Error(`样例集中不存在 ${options.testId}`);
  const turnCount = selectedCases.reduce((sum, item) => sum + item.turns.length, 0);
  console.log(`已选择 ${selectedCases.length} 条测试、${turnCount} 个轮次`);

  if (options.dryRun) {
    for (const testCase of selectedCases) {
      testCase.turns.forEach((question, index) => {
        console.log(`${testCase.testId} ${index + 1}/${testCase.turns.length}: ${question}`);
      });
    }
    return;
  }

  await loadLocalEnv();
  const apiKey = (process.env.DIFY_API_KEY ?? "").trim();
  const baseUrlValue = (process.env.DIFY_API_BASE_URL ?? "").trim();
  const user = (process.env.DIFY_USER ?? "").trim();

  if (!apiKey) throw new Error("缺少 DIFY_API_KEY");
  if (!baseUrlValue) throw new Error("缺少 DIFY_API_BASE_URL");
  if (!user) throw new Error("缺少 DIFY_USER");

  const rows = await executeCases(selectedCases, {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrlValue),
    user,
    timeoutMs: options.timeoutMs,
  });
  await writeResults(rows);
  console.log("原始结果已写入 evaluation/results/");

  if (rows.some((row) => row.execution_status !== "success")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
