import readline from "node:readline";
import process from "node:process";

import {
  CONFIG_PATH,
  cloneDefaultConfig,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "./config-store.mjs";
import { createMarkdownStreamRenderer } from "./markdown.mjs";
import { badge, heading, label, previewText, style } from "./theme.mjs";
import { listAvailableModels, runChatCompletion } from "./vllm-client.mjs";

function askLine(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function readQueuedInput() {
  if (process.stdin.isTTY) {
    return null;
  }

  process.stdin.setEncoding("utf8");
  let text = "";

  for await (const chunk of process.stdin) {
    text += chunk;
  }

  return text.split(/\r?\n/);
}

function printBanner(config) {
  console.log(heading("vLLM CLI Local Chat", "green"));
  console.log(label("model", style(config.model, "cyan")));
  console.log(label("endpoint", config.endpoint));
  console.log(
    style(
      "Enter a prompt to chat. Press Ctrl+O for options, or use /help for commands.",
      "gray",
    ),
  );
  console.log(style(`Config file: ${CONFIG_PATH}`, "gray"));
  console.log();
}

function printPromptStatus(config, history) {
  const parts = [
    `temp ${config.temperature}`,
    `top_p ${config.topP}`,
    `top_k ${config.topK}`,
    `min_p ${config.minP}`,
    `max_tokens ${config.maxTokens}`,
    `thinking ${config.enableThinking ? "on" : "off"}`,
    `stream ${config.stream ? "on" : "off"}`,
    `turns ${history.length / 2}`,
  ];

  console.log(style(parts.join(" | "), "gray"));
}

function printHelp() {
  console.log(heading("Commands", "yellow"));
  console.log("/config  open the options panel");
  console.log("/clear   clear conversation history");
  console.log("/status  show the current configuration");
  console.log("/system  print the current system prompt");
  console.log("/quit    exit the program");
  console.log();
}

function printStatus(config, history) {
  console.log(heading("Status", "cyan"));
  console.log(label("model", config.model));
  console.log(label("endpoint", config.endpoint));
  console.log(label("temperature", String(config.temperature)));
  console.log(label("top_p", String(config.topP)));
  console.log(label("top_k", String(config.topK)));
  console.log(label("min_p", String(config.minP)));
  console.log(label("max_tokens", String(config.maxTokens)));
  console.log(label("presence_penalty", String(config.presencePenalty)));
  console.log(label("repetition_penalty", String(config.repetitionPenalty)));
  console.log(label("frequency_penalty", String(config.frequencyPenalty)));
  console.log(label("thinking", config.enableThinking ? "on" : "off"));
  console.log(label("streaming", config.stream ? "on" : "off"));
  console.log(label("timeout_ms", String(config.timeoutMs)));
  console.log(label("seed", config.seed === null ? "(none)" : String(config.seed)));
  console.log(label("system prompt", previewText(config.systemPrompt, 90)));
  console.log(label("saved turns", String(history.length / 2)));
  console.log();
}

function printSystemPrompt(config) {
  console.log(heading("System Prompt", "magenta"));
  console.log(config.systemPrompt || "(empty)");
  console.log();
}

function buildMessages(config, history, userText) {
  const messages = [];

  if (config.systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: config.systemPrompt,
    });
  }

  return [...messages, ...history, { role: "user", content: userText }];
}

function normalizeAssistantContent(content) {
  return content.replace(/^\n+/, "");
}

function createRenderer() {
  let showedReasoning = false;
  let showedAssistant = false;
  let lastEndedWithNewline = true;

  const write = (text) => {
    if (!text) {
      return;
    }

    process.stdout.write(text);
    lastEndedWithNewline = text.endsWith("\n");
  };

  const ensureLineBreak = () => {
    if (!lastEndedWithNewline) {
      process.stdout.write("\n");
      lastEndedWithNewline = true;
    }
  };

  const openSection = (title, color) => {
    ensureLineBreak();
    console.log(heading(title, color));
    lastEndedWithNewline = true;
  };

  const assistantMarkdown = createMarkdownStreamRenderer({ write });

  return {
    onReasoning(text) {
      if (!text) {
        return;
      }

      if (!showedReasoning) {
        openSection("Reasoning", "magenta");
        showedReasoning = true;
      }

      write(text);
    },

    onContent(text) {
      if (!text) {
        return;
      }

      if (!showedAssistant) {
        openSection("Assistant", "green");
        showedAssistant = true;
      }

      assistantMarkdown.push(text);
    },

    finish(result) {
      if (!showedReasoning && result.reasoning) {
        this.onReasoning(result.reasoning);
      }

      if (!showedAssistant && result.content) {
        this.onContent(result.content);
      }

      assistantMarkdown.finish();
      ensureLineBreak();

      if (!result.content?.trim()) {
        console.log(
          style(
            "No final response content was returned for this turn. Try increasing max_tokens or turning thinking off if this keeps happening.",
            "yellow",
          ),
        );
      }
    },
  };
}

function printUsage(result) {
  const parts = [];

  if (result.usage?.prompt_tokens !== undefined) {
    parts.push(`prompt ${result.usage.prompt_tokens}`);
  }

  if (result.usage?.completion_tokens !== undefined) {
    parts.push(`completion ${result.usage.completion_tokens}`);
  }

  if (result.usage?.total_tokens !== undefined) {
    parts.push(`total ${result.usage.total_tokens}`);
  }

  if (result.finishReason) {
    parts.push(`finish ${result.finishReason}`);
  }

  if (parts.length > 0) {
    console.log(style(parts.join(" | "), "gray"));
    console.log();
  }
}

async function promptForInput(rl, draft = "", queuedInput = null) {
  if (queuedInput) {
    if (queuedInput.length === 0) {
      return {
        type: "quit",
        value: "",
      };
    }

    const line = queuedInput.shift() ?? "";
    console.log(`you> ${line}`);
    return {
      type: line.trim() ? "message" : "empty",
      value: line,
    };
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      rl.removeListener("line", onLine);
      process.stdin.removeListener("keypress", onKeypress);
    };

    const onLine = (line) => {
      cleanup();
      resolve({
        type: line.trim() ? "message" : "empty",
        value: line,
      });
    };

    const onKeypress = (_, key = {}) => {
      if (key.ctrl && key.name === "o") {
        const currentDraft = rl.line ?? "";
        rl.write(null, { ctrl: true, name: "u" });
        process.stdout.write("\n");
        cleanup();
        resolve({
          type: "config",
          value: currentDraft,
        });
      }

      if (key.ctrl && key.name === "c") {
        process.stdout.write("\n");
        cleanup();
        resolve({
          type: "quit",
          value: "",
        });
      }
    };

    rl.on("line", onLine);
    process.stdin.on("keypress", onKeypress);
    rl.setPrompt(style("you> ", "bold", "cyan"));
    rl.prompt();

    if (draft) {
      rl.write(draft);
    }
  });
}

async function askNumber(rl, labelText, current) {
  while (true) {
    const input = await askLine(rl, `${labelText} [${current}]: `);
    if (!input.trim()) {
      return current;
    }

    const value = Number(input);
    if (Number.isFinite(value)) {
      return value;
    }

    console.log(style("Please enter a valid number.", "red"));
  }
}

async function askInteger(rl, labelText, current) {
  while (true) {
    const input = await askLine(rl, `${labelText} [${current}]: `);
    if (!input.trim()) {
      return current;
    }

    const value = Number.parseInt(input, 10);
    if (Number.isFinite(value)) {
      return value;
    }

    console.log(style("Please enter a valid integer.", "red"));
  }
}

async function askOptionalInteger(rl, labelText, current) {
  const currentText = current === null ? "(none)" : String(current);

  while (true) {
    const input = await askLine(
      rl,
      `${labelText} [${currentText}] (blank keeps, 'none' clears): `,
    );
    const trimmed = input.trim().toLowerCase();

    if (!trimmed) {
      return current;
    }

    if (trimmed === "none") {
      return null;
    }

    const value = Number.parseInt(trimmed, 10);
    if (Number.isFinite(value)) {
      return value;
    }

    console.log(style("Please enter an integer or 'none'.", "red"));
  }
}

async function askText(rl, labelText, current) {
  const input = await askLine(rl, `${labelText} [${current}]: `);
  return input.trim() ? input.trim() : current;
}

async function chooseStartupModel(rl, config) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return config;
  }

  try {
    const { endpoint, models } = await listAvailableModels(config);

    if (models.length === 0) {
      console.log(
        style(
          `No models were returned by ${endpoint}. Using configured model ${config.model}.`,
          "yellow",
        ),
      );
      console.log();
      return config;
    }

    const currentIndex = models.findIndex((model) => model.id === config.model);

    console.log(heading("Models", "blue"));
    console.log(label("models endpoint", endpoint));
    console.log(style("Choose a model for this session.", "gray"));
    console.log();

    for (const [index, model] of models.entries()) {
      const suffix = model.id === config.model ? ` ${badge("current")}` : "";
      console.log(`${index + 1}  ${model.id}${suffix}`);
    }

    console.log();

    const prompt =
      currentIndex >= 0
        ? style(
            `model [${currentIndex + 1}] (Enter keeps current, q skips): `,
            "bold",
            "blue",
          )
        : style(
            `model [1] (Enter selects ${models[0].id}, q keeps ${config.model}): `,
            "bold",
            "blue",
          );

    while (true) {
      const input = (await askLine(rl, prompt)).trim();

      if (!input) {
        if (currentIndex >= 0) {
          console.log(style(`Using ${config.model}.`, "green"));
          console.log();
          return config;
        }

        const updated = await saveConfig({
          ...config,
          model: models[0].id,
        });
        console.log(style(`Using ${updated.model}.`, "green"));
        console.log();
        return updated;
      }

      if (["q", "quit", "skip"].includes(input.toLowerCase())) {
        console.log(style(`Keeping configured model ${config.model}.`, "gray"));
        console.log();
        return config;
      }

      const selectedByName = models.find(
        (model) => model.id.toLowerCase() === input.toLowerCase(),
      );

      if (selectedByName) {
        if (selectedByName.id === config.model) {
          console.log(style(`Using ${config.model}.`, "green"));
          console.log();
          return config;
        }

        const updated = await saveConfig({
          ...config,
          model: selectedByName.id,
        });
        console.log(style(`Using ${updated.model}.`, "green"));
        console.log();
        return updated;
      }

      const index = Number.parseInt(input, 10);
      if (Number.isFinite(index) && index >= 1 && index <= models.length) {
        const selectedModel = models[index - 1].id;

        if (selectedModel === config.model) {
          console.log(style(`Using ${config.model}.`, "green"));
          console.log();
          return config;
        }

        const updated = await saveConfig({
          ...config,
          model: selectedModel,
        });
        console.log(style(`Using ${updated.model}.`, "green"));
        console.log();
        return updated;
      }

      console.log(
        style(
          "Enter a model number, an exact model id, or q to keep the configured model.",
          "red",
        ),
      );
    }
  } catch (error) {
    console.log(
      style(
        `Could not query available models. Using configured model ${config.model}. ${error.message}`,
        "yellow",
      ),
    );
    console.log();
    return config;
  }
}

async function askSystemPrompt(rl, current) {
  console.log(style("Enter the new system prompt one line at a time.", "gray"));
  console.log(style("Enter '.' on its own line to finish.", "gray"));
  console.log(style("Enter '.' immediately to keep the current prompt.", "gray"));
  console.log(style("Enter '!blank' as the first line to clear it.", "gray"));

  const lines = [];

  while (true) {
    const line = await askLine(
      rl,
      lines.length === 0 ? "system> " : "......> ",
    );

    if (line === "." && lines.length === 0) {
      return current;
    }

    if (line === "!blank" && lines.length === 0) {
      return "";
    }

    if (line === ".") {
      return lines.join("\n");
    }

    lines.push(line);
  }
}

function printConfigMenu(config) {
  console.log(heading("Options", "yellow"));
  console.log(`1  endpoint          ${config.endpoint}`);
  console.log(`2  model             ${config.model}`);
  console.log(`3  system prompt     ${previewText(config.systemPrompt, 68)}`);
  console.log(`4  temperature       ${config.temperature}`);
  console.log(`5  top_p             ${config.topP}`);
  console.log(`6  top_k             ${config.topK}`);
  console.log(`7  min_p             ${config.minP}`);
  console.log(`8  max_tokens        ${config.maxTokens}`);
  console.log(`9  presence_penalty  ${config.presencePenalty}`);
  console.log(`10 repetition_penalty ${config.repetitionPenalty}`);
  console.log(`11 frequency_penalty ${config.frequencyPenalty}`);
  console.log(`12 thinking          ${config.enableThinking ? badge("on") : badge("off", "gray")}`);
  console.log(`13 streaming         ${config.stream ? badge("on") : badge("off", "gray")}`);
  console.log(`14 timeout_ms        ${config.timeoutMs}`);
  console.log(`15 seed              ${config.seed === null ? "(none)" : config.seed}`);
  console.log("d  restore defaults");
  console.log("q  return to chat");
  console.log();
}

async function openConfigPanel(rl, currentConfig) {
  let config = normalizeConfig(currentConfig);

  while (true) {
    printConfigMenu(config);
    const choice = (await askLine(rl, style("config> ", "bold", "yellow")))
      .trim()
      .toLowerCase();

    if (!choice || choice === "q") {
      console.log();
      return config;
    }

    if (choice === "d") {
      config = cloneDefaultConfig();
      config = await saveConfig(config);
      console.log(style("Defaults restored and saved.", "green"));
      console.log();
      continue;
    }

    switch (choice) {
      case "1":
        config.endpoint = await askText(rl, "endpoint", config.endpoint);
        break;
      case "2":
        config.model = await askText(rl, "model", config.model);
        break;
      case "3":
        config.systemPrompt = await askSystemPrompt(rl, config.systemPrompt);
        break;
      case "4":
        config.temperature = await askNumber(rl, "temperature", config.temperature);
        break;
      case "5":
        config.topP = await askNumber(rl, "top_p", config.topP);
        break;
      case "6":
        config.topK = await askInteger(rl, "top_k", config.topK);
        break;
      case "7":
        config.minP = await askNumber(rl, "min_p", config.minP);
        break;
      case "8":
        config.maxTokens = await askInteger(rl, "max_tokens", config.maxTokens);
        break;
      case "9":
        config.presencePenalty = await askNumber(
          rl,
          "presence_penalty",
          config.presencePenalty,
        );
        break;
      case "10":
        config.repetitionPenalty = await askNumber(
          rl,
          "repetition_penalty",
          config.repetitionPenalty,
        );
        break;
      case "11":
        config.frequencyPenalty = await askNumber(
          rl,
          "frequency_penalty",
          config.frequencyPenalty,
        );
        break;
      case "12":
        config.enableThinking = !config.enableThinking;
        console.log(
          style(
            `Thinking is now ${config.enableThinking ? "on" : "off"}.`,
            "green",
          ),
        );
        console.log();
        break;
      case "13":
        config.stream = !config.stream;
        console.log(
          style(`Streaming is now ${config.stream ? "on" : "off"}.`, "green"),
        );
        console.log();
        break;
      case "14":
        config.timeoutMs = await askInteger(rl, "timeout_ms", config.timeoutMs);
        break;
      case "15":
        config.seed = await askOptionalInteger(rl, "seed", config.seed);
        break;
      default:
        console.log(style("Unknown option. Pick one of the menu entries.", "red"));
        console.log();
        continue;
    }

    config = await saveConfig(config);
    console.log(style("Options saved.", "green"));
    console.log();
  }
}

async function handleCommand(rl, config, history, commandText) {
  const command = commandText.trim().toLowerCase();

  switch (command) {
    case "/help":
      printHelp();
      return { type: "continue", config, history };
    case "/clear":
      console.log(style("Conversation history cleared.", "green"));
      console.log();
      return { type: "continue", config, history: [] };
    case "/config":
      return {
        type: "continue",
        config: await openConfigPanel(rl, config),
        history,
      };
    case "/status":
      printStatus(config, history);
      return { type: "continue", config, history };
    case "/system":
      printSystemPrompt(config);
      return { type: "continue", config, history };
    case "/quit":
      return { type: "quit", config, history };
    default:
      console.log(style("Unknown command. Use /help to see available commands.", "red"));
      console.log();
      return { type: "continue", config, history };
  }
}

async function main() {
  let config;

  try {
    config = await loadConfig();
  } catch (error) {
    console.log(
      style(
        `Could not read ${CONFIG_PATH}. Falling back to defaults. ${error.message}`,
        "yellow",
      ),
    );
    config = await saveConfig(cloneDefaultConfig());
  }

  const queuedInput = await readQueuedInput();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.setRawMode(true);
  }

  let history = [];
  let draft = "";

  config = await chooseStartupModel(rl, config);

  printBanner(config);

  try {
    while (true) {
      printPromptStatus(config, history);
      const inputResult = await promptForInput(rl, draft, queuedInput);
      draft = "";

      if (inputResult.type === "quit") {
        break;
      }

      if (inputResult.type === "config") {
        config = await openConfigPanel(rl, config);
        draft = inputResult.value;
        continue;
      }

      if (inputResult.type === "empty") {
        continue;
      }

      const userText = inputResult.value;

      if (userText.trim().startsWith("/")) {
        const commandResult = await handleCommand(rl, config, history, userText);
        config = commandResult.config;
        history = commandResult.history;
        if (commandResult.type === "quit") {
          break;
        }
        continue;
      }

      const renderer = createRenderer();
      const requestMessages = buildMessages(config, history, userText);

      console.log();

      try {
        const result = await runChatCompletion(config, requestMessages, {
          onReasoning: (chunk) => renderer.onReasoning(chunk),
          onContent: (chunk) => renderer.onContent(chunk),
        });

        renderer.finish(result);
        printUsage(result);

        if (result.content?.trim()) {
          history.push({ role: "user", content: userText });
          history.push({
            role: "assistant",
            content: normalizeAssistantContent(result.content),
          });
        } else {
          console.log(
            style(
              "This turn was not added to history because the model did not emit final response content.",
              "yellow",
            ),
          );
          console.log();
        }
      } catch (error) {
        console.log(style(`Request failed: ${error.message}`, "red"));
        console.log(
          style("Nothing was added to history for this turn.", "yellow"),
        );
        console.log();
      }
    }
  } finally {
    rl.close();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  console.log(style("Bye.", "gray"));
}

await main();
