// Reasoning-lane model for the deep agent. Gemini by default; Groq-hosted gpt-oss-120b is a
// one-env-var switch if the Gemini free quota runs out mid-review.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatMistralAI } from "@langchain/mistralai";
import { colabEndpoint } from "./router";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { isOpenAITool } from "@langchain/core/language_models/base";

type Json = Record<string, unknown>;

// Gemini's function-declaration schema is an OpenAPI subset: no type arrays, no exclusive bounds,
// no $schema/additionalProperties/defaults. Tool schemas (ours and deepagents' built-ins) are
// cleaned into that subset before they reach the API.
const DROP = new Set(["$schema", "additionalProperties", "exclusiveMinimum", "exclusiveMaximum", "default", "examples", "title", "$defs", "definitions", "propertyNames", "patternProperties", "const"]);

export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const src = schema as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    if (DROP.has(key)) continue;
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Json).map(([name, s]) => [name, toGeminiSchema(s)]))
        : toGeminiSchema(value);
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== "null");
    if (types.length < (out.type as string[]).length) out.nullable = true;
    out.type = types[0] ?? "string";
  }
  for (const combinator of ["anyOf", "oneOf"] as const) {
    const options = out[combinator] as Json[] | undefined;
    if (!options) continue;
    const nonNull = options.filter((o) => o.type !== "null");
    if (nonNull.length === 1) {
      const { [combinator]: _drop, ...rest } = out;
      void _drop;
      return { ...rest, ...nonNull[0], ...(nonNull.length < options.length ? { nullable: true } : {}) };
    }
    if (combinator === "oneOf") {
      out.anyOf = nonNull;
      delete out.oneOf;
    }
  }
  return out;
}

class GeminiChat extends ChatGoogleGenerativeAI {
  override bindTools(tools: Parameters<ChatGoogleGenerativeAI["bindTools"]>[0], kwargs?: Parameters<ChatGoogleGenerativeAI["bindTools"]>[1]) {
    const functionDeclarations = tools.map((t) => {
      const fn = (isOpenAITool(t) ? t : convertToOpenAITool(t as never)).function;
      const params = toGeminiSchema(fn.parameters) as Json | undefined;
      const hasParams = params && Object.keys((params.properties as Json) ?? {}).length > 0;
      return { name: fn.name, description: fn.description ?? fn.name, ...(hasParams ? { parameters: params } : {}) };
    });
    return super.bindTools([{ functionDeclarations } as never], kwargs);
  }
}

export type Provider = "gemini" | "groq" | "mistral" | "colab";
export type ModelSpec = { provider: Provider; model: string; keyIndex: number };
type ChatModel = ChatOpenAI | GeminiChat | ChatMistralAI;

export interface PoolMember {
  /** Stable id used by the quota ledger, e.g. "gemini-3.8-flash@k1". Never contains the key itself. */
  id: string;
  spec: ModelSpec;
  /** Requests per day on the free tier; null = unknown (rely on 429 detection). */
  dailyBudget: number | null;
  /** Resolved at call time: the self-hosted model's address changes every Colab session. */
  resolve: () => Promise<ChatModel | null>;
}

export function geminiKeys(): string[] {
  const keys = (process.env.GOOGLE_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (process.env.GOOGLE_API_KEY && !keys.includes(process.env.GOOGLE_API_KEY)) keys.unshift(process.env.GOOGLE_API_KEY);
  return keys;
}

// maxRetries 0 everywhere: on a quota error the pool moves to the next member instead of sleeping.
function makeModel(spec: ModelSpec): () => Promise<ChatModel | null> {
  switch (spec.provider) {
    case "groq": {
      const m = new ChatOpenAI({ model: spec.model, apiKey: process.env.GROQ_API_KEY, configuration: { baseURL: "https://api.groq.com/openai/v1" }, temperature: 0, maxRetries: 0 });
      return async () => m;
    }
    case "mistral": {
      const m = new ChatMistralAI({ model: spec.model, apiKey: process.env.MISTRAL_API_KEY, temperature: 0, maxRetries: 0 });
      return async () => m;
    }
    case "colab":
      return async () => {
        const ep = await colabEndpoint();
        if (!ep) return null;
        // Ollama's OpenAI-compatible endpoint behind the notebook's Cloudflare tunnel.
        return new ChatOpenAI({ model: ep.model, apiKey: "ollama", configuration: { baseURL: `${ep.url.replace(/\/$/, "")}/v1` }, temperature: 0, maxRetries: 0 });
      };
    default: {
      const m = new GeminiChat({ model: spec.model, apiKey: geminiKeys()[spec.keyIndex], temperature: 0, maxRetries: 0 });
      return async () => m;
    }
  }
}

/** Free-tier daily request caps observed for this account (Flash family: 20/day/project/model). */
function dailyBudget(model: string): number | null {
  const override = process.env[`RPD_${model.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`];
  if (override) return Number(override);
  if (/^gemini-[\d.]+-flash$|^gemini-3-flash-preview$/.test(model)) return 20;
  return null;
}

/**
 * Ordered reasoning pool, best first. Gemini members are multiplied by API key (separate projects
 * = separate quotas). Mistral's free tier carries volume; the self-hosted Llama on Colab is the
 * last resort that keeps the clinic running when every cloud quota is spent.
 * Override with REASONING_POOL="gemini:model,mistral:model,colab:llama,groq:model".
 */
export function reasoningPool(): PoolMember[] {
  const models =
    process.env.REASONING_POOL ??
    (process.env.MAIN_MODEL_PROVIDER === "groq"
      ? "groq:openai/gpt-oss-120b"
      : [
          // 3.5 Flash first: 2-6 s per step vs 10-25 s for 3.8 Flash, with the same tool accuracy here.
          "gemini:gemini-3.5-flash",
          `gemini:${process.env.GEMINI_MODEL ?? "gemini-3.8-flash"}`,
          // Free Mistral tier on this account: ministral-14b 30 req/min, ministral-8b 188 req/min.
          ...(process.env.MISTRAL_API_KEY ? [`mistral:${process.env.MISTRAL_MODEL ?? "ministral-14b-latest"}`, "mistral:ministral-8b-latest"] : []),
          "gemini:gemini-3-flash-preview",
          "gemini:gemini-3.1-flash-lite",
          "gemini:gemini-3.5-flash-lite",
          "colab:self-hosted-llama",
          "gemini:gemma-4-26b-a4b-it",
          ...(process.env.GROQ_API_KEY ? ["groq:openai/gpt-oss-120b"] : []),
        ].join(","));
  const keyCount = Math.max(1, geminiKeys().length);
  const members: PoolMember[] = [];
  for (const entry of models.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [raw, ...rest] = entry.split(":");
    const provider = (["groq", "mistral", "colab"].includes(raw) ? raw : "gemini") as Provider;
    const model = rest.join(":");
    const keys = provider === "gemini" ? keyCount : 1;
    for (let k = 0; k < keys; k++) {
      const spec: ModelSpec = { provider, model, keyIndex: k };
      const id = provider === "gemini" ? `${model}@k${k + 1}` : provider === "colab" ? "colab-llama (self-hosted)" : provider === "mistral" ? `mistral/${model}` : model;
      members.push({ id, spec, dailyBudget: dailyBudget(model), resolve: makeModel(spec) });
    }
  }
  return members;
}
