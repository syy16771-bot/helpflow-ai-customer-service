# 公开样例批量执行器

该执行器读取 `evaluation/test-cases-sample.md` 中的 12 条公开样例，调用已发布的 HelpFlow 对话应用并收集原始回答。它不会自动评分，也不会修改应用配置。

## 环境要求

- Node.js 18 或更高版本。
- 一个可调用的已发布 Dify 对话应用。

## 本地配置

1. 将 `.env.example` 复制为当前目录下的 `.env`。
2. 仅在本地 `.env` 中填写三个变量：
   - `DIFY_API_KEY`
   - `DIFY_API_BASE_URL`
   - `DIFY_USER`
3. 不要提交 `.env`、终端截图或包含请求鉴权信息的日志。

`.env.example` 只保留空变量名，仓库的 `.gitignore` 允许示例文件但忽略真实环境文件。

## 使用方式

仅检查样例解析，不发送请求：

```bash
node evaluation/batch-runner/run-sample-evaluation.mjs --dry-run
```

执行全部 12 条公开样例：

```bash
node evaluation/batch-runner/run-sample-evaluation.mjs
```

只执行一个测试，例如 T039：

```bash
node evaluation/batch-runner/run-sample-evaluation.mjs --id T039
```

需要调整单次等待时限时：

```bash
node evaluation/batch-runner/run-sample-evaluation.mjs --timeout 240
```

结果写入 `evaluation/results/`，该目录默认不会提交。多轮样例在同一测试内部传递会话标识，不同测试之间使用独立新会话。

## 输出字段

- 测试 ID、场景、轮次和用户问题
- AI 实际回答
- 会话标识与消息标识
- 执行成功或失败、错误信息
- 响应时间和执行时间

执行器只负责重复执行和结果收集。Pass / Fail 应由人工依据公开测试样例中的预期要点判断。
