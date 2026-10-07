import { ApiProviderError } from "./types.ts";
import type {
  ApiChatCompletion,
  ApiChatMessage,
  ApiChatRequest,
  ApiToolCall,
  ApiToolDefinition,
  ProviderId,
} from "./types.ts";

const endpoints = {
  deepseek: {
    models: "https://api.deepseek.com/models",
    chat: "https://api.deepseek.com/chat/completions",
  },
  openai: {
    models: "https://api.openai.com/v1/models",
    chat: "https://api.openai.com/v1/chat/completions",
  },
  gemini: {
    models: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    chat: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
} as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const toolNamePattern = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const maxRequestBytes = 256 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const maxMessages = 64;
/** Tool calls in one assistant message. */
const maxToolCalls = 8;
/** Tool definitions offered in one request (the editor offers 12). */
const maxToolDefinitions = 16;
const maxThoughtSignatureBytes = 16 * 1024;
const geminiClientHeader = "ai-video-editor/0.0.0";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiProviderError("invalid_response");
  return value as Record<string, unknown>;
}

function providerUrls(provider: ProviderId) {
  if (typeof provider !== "string" || !Object.hasOwn(endpoints, provider))
    throw new ApiProviderError("invalid_request");
  return endpoints[provider];
}

function validKey(apiKey: string): void {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < 8 ||
    apiKey.length > 4096 ||
    /[\r\n\0]/.test(apiKey)
  )
    throw new ApiProviderError("invalid_request");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function validThoughtSignature(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxThoughtSignatureBytes &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validateMessages(
  messages: ApiChatMessage[],
  provider: ProviderId,
): unknown[] {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > maxMessages
  )
    throw new ApiProviderError("invalid_request");
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    if (!message || typeof message !== "object")
      throw new ApiProviderError("invalid_request");
    if (message.role === "system" || message.role === "user") {
      if (!validText(message.content, 32 * 1024))
        throw new ApiProviderError("invalid_request");
      return { role: message.role, content: message.content };
    }
    if (message.role === "tool") {
      if (
        !validText(message.content, 64 * 1024) ||
        !validId(message.toolCallId) ||
        (provider === "gemini" && !toolNames.has(message.toolCallId))
      )
        throw new ApiProviderError("invalid_request");
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(provider === "gemini"
          ? { name: toolNames.get(message.toolCallId) }
          : {}),
      };
    }
    if (message.role === "assistant") {
      if (message.content !== null && !validText(message.content, 64 * 1024))
        throw new ApiProviderError("invalid_request");
      const calls = message.toolCalls;
      if (
        calls !== undefined &&
        (!Array.isArray(calls) || calls.length > maxToolCalls)
      )
        throw new ApiProviderError("invalid_request");
      return {
        role: "assistant",
        content: message.content,
        ...(calls
          ? {
              tool_calls: calls.map((call) => {
                if (
                  !validId(call.id) ||
                  !toolNamePattern.test(call.name) ||
                  !validText(call.arguments, 64 * 1024) ||
                  (call.thoughtSignature !== undefined &&
                    (provider !== "gemini" ||
                      !validThoughtSignature(call.thoughtSignature)))
                )
                  throw new ApiProviderError("invalid_request");
                if (provider === "gemini") toolNames.set(call.id, call.name);
                return {
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                  ...(call.thoughtSignature === undefined
                    ? {}
                    : {
                        extra_content: {
                          google: { thought_signature: call.thoughtSignature },
                        },
                      }),
                };
              }),
            }
          : {}),
      };
    }
    throw new ApiProviderError("invalid_request");
  });
}

function validateTools(
  tools: ApiToolDefinition[] | undefined,
): unknown[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length > maxToolDefinitions)
    throw new ApiProviderError("invalid_request");
  const names = new Set<string>();
  return tools.map((tool) => {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      !toolNamePattern.test(tool.name) ||
      !validText(tool.description, 2048) ||
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters) ||
      names.has(tool.name)
    )
      throw new ApiProviderError("invalid_request");
    names.add(tool.name);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
}

function requestBody(request: ApiChatRequest, provider: ProviderId): string {
  if (!request || typeof request !== "object" || !validId(request.model))
    throw new ApiProviderError("invalid_request");
  if (
    request.maxTokens !== undefined &&
    (!Number.isInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > 8192)
  )
    throw new ApiProviderError("invalid_request");
  const messages = validateMessages(request.messages, provider);
  const tools = validateTools(request.tools);
  let body: string;
  try {
    body = JSON.stringify({
      model: request.model,
      messages,
      stream: false,
      ...(tools?.length ? { tools } : {}),
      ...(provider === "gemini"
        ? { max_completion_tokens: request.maxTokens ?? 4096 }
        : { max_tokens: request.maxTokens ?? 4096 }),
    });
  } catch {
    throw new ApiProviderError("invalid_request");
  }
  if (Buffer.byteLength(body) > maxRequestBytes)
    throw new ApiProviderError("invalid_request");
  return body;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxResponseBytes)
    throw new ApiProviderError("invalid_response");
  if (!response.body) throw new ApiProviderError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes)
        throw new ApiProviderError("invalid_response");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new ApiProviderError("invalid_response");
  }
}

function decodeModels(raw: unknown): string[] {
  const data = object(raw).data;
  if (!Array.isArray(data) || data.length > 1024)
    throw new ApiProviderError("invalid_response");
  const ids = new Set<string>();
  for (const entry of data) {
    const id = object(entry).id;
    if (!validId(id)) throw new ApiProviderError("invalid_response");
    ids.add(id);
  }
  return [...ids].sort();
}

function decodeCompletion(
  raw: unknown,
  provider: ProviderId,
): ApiChatCompletion {
  const top = object(raw);
  if (!validId(top.model)) throw new ApiProviderError("invalid_response");
  if (!Array.isArray(top.choices) || top.choices.length < 1)
    throw new ApiProviderError("invalid_response");
  const first = object(top.choices[0]);
  const message = object(first.message);
  const finishReason = first.finish_reason;
  if (
    !validText(finishReason, 64) ||
    ![
      "stop",
      "length",
      "content_filter",
      "tool_calls",
      "function_call",
      "insufficient_system_resource",
      "aborted",
    ].includes(finishReason) ||
    (message.content !== null && !validText(message.content, 256 * 1024))
  )
    throw new ApiProviderError("invalid_response");
  const rawCalls = message.tool_calls;
  if (
    rawCalls !== undefined &&
    (!Array.isArray(rawCalls) || rawCalls.length > maxToolCalls)
  )
    throw new ApiProviderError("invalid_response");
  const toolCalls: ApiToolCall[] = (rawCalls ?? []).map((rawCall: unknown) => {
    const call = object(rawCall);
    const functionCall = object(call.function);
    let thoughtSignature: string | undefined;
    if (call.extra_content !== undefined) {
      if (provider !== "gemini") throw new ApiProviderError("invalid_response");
      const extra = object(call.extra_content);
      if (Object.keys(extra).length !== 1 || !Object.hasOwn(extra, "google"))
        throw new ApiProviderError("invalid_response");
      const google = object(extra.google);
      if (
        Object.keys(google).length !== 1 ||
        !Object.hasOwn(google, "thought_signature") ||
        !validThoughtSignature(google.thought_signature)
      )
        throw new ApiProviderError("invalid_response");
      thoughtSignature = google.thought_signature;
    }
    if (
      call.type !== "function" ||
      !validId(call.id) ||
      typeof functionCall.name !== "string" ||
      !toolNamePattern.test(functionCall.name) ||
      !validText(functionCall.arguments, 64 * 1024)
    )
      throw new ApiProviderError("invalid_response");
    try {
      const parsed: unknown = JSON.parse(functionCall.arguments);
      object(parsed);
    } catch {
      throw new ApiProviderError("invalid_response");
    }
    return {
      id: call.id,
      name: functionCall.name,
      arguments: functionCall.arguments,
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
  });
  if (message.content === null && toolCalls.length === 0)
    throw new ApiProviderError("invalid_response");
  return {
    model: top.model,
    content: message.content,
    toolCalls,
    finishReason,
  };
}

export interface ApiProviderClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Main-process transport. It never accepts a caller-supplied origin or follows redirects. */
export class ApiProviderClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiProviderClientOptions = {}) {
    // Resolve the main-process transport at call time. Isolated native tests
    // can replace it after Electron starts without adding a renderer API or
    // a production credential/endpoint override.
    this.fetchImpl =
      options.fetchImpl ??
      ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 120_000
    )
      throw new ApiProviderError("invalid_request");
  }

  private async call(
    provider: ProviderId,
    url: string,
    apiKey: string,
    method: "GET" | "POST",
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    validKey(apiKey);
    if (signal?.aborted) throw new ApiProviderError("request_cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(provider === "gemini"
            ? { "x-goog-api-client": geminiClientHeader }
            : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== url))
        throw new ApiProviderError("invalid_response");
      if (response.status === 401 || response.status === 403)
        throw new ApiProviderError("authentication_failed");
      if (response.status === 429) throw new ApiProviderError("rate_limited");
      if (!response.ok) throw new ApiProviderError("provider_rejected");
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof ApiProviderError) throw error;
      if (signal?.aborted) throw new ApiProviderError("request_cancelled");
      if (timedOut) throw new ApiProviderError("request_timeout");
      throw new ApiProviderError("network_error");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  async listModels(
    provider: ProviderId,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const url = providerUrls(provider).models;
    return decodeModels(
      await this.call(provider, url, apiKey, "GET", undefined, signal),
    );
  }

  async complete(
    provider: ProviderId,
    apiKey: string,
    request: ApiChatRequest,
    signal?: AbortSignal,
  ): Promise<ApiChatCompletion> {
    const url = providerUrls(provider).chat;
    return decodeCompletion(
      await this.call(
        provider,
        url,
        apiKey,
        "POST",
        requestBody(request, provider),
        signal,
      ),
      provider,
    );
  }
}
