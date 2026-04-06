import assert from "node:assert/strict";

import {
  createMarkdownStreamRenderer,
  renderMarkdown,
} from "../src/markdown.mjs";
import {
  applyChatCompletionChunk,
  applyChatCompletionResponse,
  buildModelsEndpoint,
  buildChatCompletionBody,
  createChatResult,
  extractAvailableModels,
  extractSsePayloads,
} from "../src/vllm-client.mjs";

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

run("buildChatCompletionBody uses top-level thinking config", () => {
  const body = buildChatCompletionBody(
    {
      model: "Qwen3.5-9B-local",
      temperature: 0.4,
      topP: 0.9,
      topK: 20,
      minP: 0.05,
      maxTokens: 512,
      presencePenalty: 0,
      repetitionPenalty: 1.1,
      frequencyPenalty: 0,
      enableThinking: false,
      stream: true,
      seed: 42,
    },
    [{ role: "user", content: "hello" }],
  );

  assert.equal(body.model, "Qwen3.5-9B-local");
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.stream, true);
  assert.equal(body.top_k, 20);
  assert.equal(body.min_p, 0.05);
  assert.equal(body.repetition_penalty, 1.1);
  assert.equal(body.seed, 42);
});

run("buildModelsEndpoint rewrites chat completions URLs to models", () => {
  assert.equal(
    buildModelsEndpoint("http://127.0.0.1:8000/v1/chat/completions"),
    "http://127.0.0.1:8000/v1/models",
  );
  assert.equal(
    buildModelsEndpoint("http://127.0.0.1:8000/v1"),
    "http://127.0.0.1:8000/v1/models",
  );
});

run("extractAvailableModels keeps unique model ids", () => {
  const models = extractAvailableModels({
    object: "list",
    data: [
      { id: "Qwen3.5-9B-local", owned_by: "vllm" },
      { model: "Qwen3.5-9B-local" },
      { name: "Qwen3.5-32B-local" },
      { root: "adapter-model" },
      {},
    ],
  });

  assert.deepEqual(models, [
    { id: "Qwen3.5-9B-local", ownedBy: "vllm" },
    { id: "Qwen3.5-32B-local", ownedBy: null },
    { id: "adapter-model", ownedBy: null },
  ]);
});

run("extractSsePayloads returns complete payloads and remainder", () => {
  const raw = [
    'data: {"a":1}',
    "",
    'data: {"b":2}',
    "",
    'data: {"c":3}',
  ].join("\n");

  const extracted = extractSsePayloads(raw);

  assert.deepEqual(extracted.payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(extracted.remainder, 'data: {"c":3}');
});

run("applyChatCompletionChunk accumulates reasoning and content", () => {
  const result = createChatResult();

  applyChatCompletionChunk(result, {
    id: "chunk-1",
    model: "Qwen3.5-9B-local",
    choices: [
      {
        delta: {
          reasoning: "Thinking...",
        },
        finish_reason: null,
      },
    ],
  });

  applyChatCompletionChunk(result, {
    choices: [
      {
        delta: {
          content: "Hello!",
        },
        finish_reason: "stop",
      },
    ],
  });

  assert.equal(result.id, "chunk-1");
  assert.equal(result.model, "Qwen3.5-9B-local");
  assert.equal(result.reasoning, "Thinking...");
  assert.equal(result.content, "Hello!");
  assert.equal(result.finishReason, "stop");
});

run("applyChatCompletionResponse reads final response payloads", () => {
  const result = applyChatCompletionResponse(createChatResult(), {
    id: "chat-1",
    model: "Qwen3.5-9B-local",
    choices: [
      {
        message: {
          reasoning: "Reasoning text",
          content: "Final answer",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  });

  assert.equal(result.id, "chat-1");
  assert.equal(result.reasoning, "Reasoning text");
  assert.equal(result.content, "Final answer");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.total_tokens, 30);
});

run("renderMarkdown formats common chat markdown", () => {
  const output = stripAnsi(
    renderMarkdown(
      [
        "# Title",
        "- [x] shipped",
        "1. First step",
        "> quoted",
        "Visit [docs](https://example.com)",
        "---",
        "```js",
        "const answer = 42;",
        "```",
      ].join("\n"),
    ),
  );

  assert.equal(
    output,
    [
      "Title",
      "- [x] shipped",
      "1. First step",
      "> quoted",
      "Visit docs (https://example.com)",
      "-".repeat(72),
      "[code: js]",
      "    const answer = 42;",
      "",
    ].join("\n"),
  );
});

run("createMarkdownStreamRenderer flushes completed lines and final partials", () => {
  const writes = [];
  const renderer = createMarkdownStreamRenderer({
    write: (chunk) => {
      writes.push(chunk);
    },
  });

  renderer.push("Hello **world**");
  assert.equal(stripAnsi(writes.join("")), "");

  renderer.push("\n```js\nconst x = 1;\n");
  assert.equal(
    stripAnsi(writes.join("")),
    "Hello world\n[code: js]\n    const x = 1;\n",
  );

  renderer.push("```\nVisit [site](https://example.com)");
  renderer.finish();

  assert.equal(
    stripAnsi(writes.join("")),
    [
      "Hello world",
      "[code: js]",
      "    const x = 1;",
      "",
      "Visit site (https://example.com)",
    ].join("\n"),
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
