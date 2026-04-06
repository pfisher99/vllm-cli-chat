const JSON_HEADERS = {
  "content-type": "application/json",
};

export function createChatResult() {
  return {
    id: null,
    model: null,
    reasoning: "",
    content: "",
    finishReason: null,
    stopReason: null,
    usage: null,
  };
}

export function buildChatCompletionBody(config, messages) {
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    top_p: config.topP,
    top_k: config.topK,
    min_p: config.minP,
    max_tokens: config.maxTokens,
    presence_penalty: config.presencePenalty,
    repetition_penalty: config.repetitionPenalty,
    frequency_penalty: config.frequencyPenalty,
    stream: Boolean(config.stream),
    chat_template_kwargs: {
      enable_thinking: Boolean(config.enableThinking),
    },
  };

  if (Number.isInteger(config.seed)) {
    body.seed = config.seed;
  }

  return body;
}

export function buildModelsEndpoint(endpoint) {
  const raw = String(endpoint ?? "").trim();

  if (!raw) {
    return "/v1/models";
  }

  try {
    const url = new URL(raw);

    if (/\/chat\/completions\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
    } else if (/\/v1\/?$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    } else if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1/models";
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    }

    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function extractAvailableModels(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  const seen = new Set();

  for (const item of items) {
    const id = [item?.id, item?.model, item?.name, item?.root].find(
      (value) => typeof value === "string" && value.trim(),
    );

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    models.push({
      id,
      ownedBy:
        typeof item?.owned_by === "string" && item.owned_by.trim()
          ? item.owned_by
          : null,
    });
  }

  return models;
}

export function extractSsePayloads(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const payloads = [];

  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) {
        payloads.push(line.slice(6));
      }
    }
  }

  return { payloads, remainder };
}

export function applyChatCompletionChunk(result, payload) {
  if (!result.id && payload.id) {
    result.id = payload.id;
  }

  if (!result.model && payload.model) {
    result.model = payload.model;
  }

  const choice = payload.choices?.[0] ?? {};
  const delta = choice.delta ?? {};

  const reasoningDelta =
    typeof delta.reasoning === "string" ? delta.reasoning : "";
  const contentDelta =
    typeof delta.content === "string" ? delta.content : "";

  if (reasoningDelta) {
    result.reasoning += reasoningDelta;
  }

  if (contentDelta) {
    result.content += contentDelta;
  }

  if (typeof choice.finish_reason === "string") {
    result.finishReason = choice.finish_reason;
  }

  if (typeof choice.stop_reason === "string") {
    result.stopReason = choice.stop_reason;
  }

  if (payload.usage) {
    result.usage = payload.usage;
  }

  return {
    reasoningDelta,
    contentDelta,
    finishReason: result.finishReason,
    stopReason: result.stopReason,
  };
}

export function applyChatCompletionResponse(result, payload) {
  if (payload.id) {
    result.id = payload.id;
  }

  if (payload.model) {
    result.model = payload.model;
  }

  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};

  result.reasoning =
    typeof message.reasoning === "string" ? message.reasoning : "";
  result.content = typeof message.content === "string" ? message.content : "";
  result.finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  result.stopReason =
    typeof choice.stop_reason === "string" ? choice.stop_reason : null;
  result.usage = payload.usage ?? null;

  return result;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function fetchWithTimeout(endpoint, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`The request timed out after ${timeoutMs} ms.`),
    );
  }, timeoutMs);

  try {
    const response = await fetch(endpoint, {
      ...init,
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      const reason = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error("The request was aborted.");
    }

    const cause = error?.cause;
    const details = [];

    if (cause?.code) {
      details.push(cause.code);
    }

    if (cause?.address && cause?.port) {
      details.push(`${cause.address}:${cause.port}`);
    }

    if (cause?.message) {
      details.push(cause.message);
    } else if (error?.message) {
      details.push(error.message);
    }

    const suffix = details.length > 0 ? ` ${details.join(" | ")}` : "";
    throw new Error(`Could not reach ${endpoint}.${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchChatCompletion(endpoint, body, timeoutMs, handlers) {
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(
      `vLLM returned ${response.status}: ${await readErrorBody(response)}`,
    );
  }

  const payload = await response.json();
  const result = applyChatCompletionResponse(createChatResult(), payload);

  if (result.reasoning) {
    handlers.onReasoning?.(result.reasoning, result);
  }

  if (result.content) {
    handlers.onContent?.(result.content, result);
  }

  return result;
}

async function streamChatCompletion(endpoint, body, timeoutMs, handlers) {
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(
      `vLLM returned ${response.status}: ${await readErrorBody(response)}`,
    );
  }

  if (!response.body) {
    throw new Error("The vLLM response did not include a readable body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result = createChatResult();
  let remainder = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    remainder += decoder.decode(value, { stream: true });
    const extracted = extractSsePayloads(remainder);
    remainder = extracted.remainder;

    for (const payloadText of extracted.payloads) {
      if (payloadText === "[DONE]") {
        return result;
      }

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw new Error(`Could not parse streaming payload: ${payloadText}`);
      }

      const update = applyChatCompletionChunk(result, payload);

      if (update.reasoningDelta) {
        handlers.onReasoning?.(update.reasoningDelta, result);
      }

      if (update.contentDelta) {
        handlers.onContent?.(update.contentDelta, result);
      }
    }
  }

  const finalText = remainder.trim();
  if (finalText && finalText !== "data: [DONE]") {
    throw new Error(`The stream ended with unread data: ${finalText}`);
  }

  return result;
}

export async function runChatCompletion(config, messages, handlers = {}) {
  const body = buildChatCompletionBody(config, messages);

  if (config.stream) {
    return streamChatCompletion(config.endpoint, body, config.timeoutMs, handlers);
  }

  return fetchChatCompletion(config.endpoint, body, config.timeoutMs, handlers);
}

export async function listAvailableModels(config) {
  const endpoint = buildModelsEndpoint(config.endpoint);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    },
    config.timeoutMs,
  );

  if (!response.ok) {
    throw new Error(
      `vLLM returned ${response.status}: ${await readErrorBody(response)}`,
    );
  }

  const payload = await response.json();

  return {
    endpoint,
    models: extractAvailableModels(payload),
  };
}
