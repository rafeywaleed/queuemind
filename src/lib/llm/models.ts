// Reasoning-lane model for the deep agent. Gemini by default; Groq-hosted gpt-oss-120b is a
// one-env-var switch if the Gemini free quota runs out mid-review.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
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

export type ModelSpec = { provider: "gemini" | "groq"; model: string; keyIndex: number };

export interface PoolMember {
  /** Stable id used by the quota ledger, e.g. "gemini-3.8-flash@k1". Never contains the key itself. */
  id: string;
  spec: ModelSpec;
  /** Requests per day on the free tier; null = unknown (rely on 429 detection). */
  dailyBudget: number | null;
  model: ChatOpenAI | GeminiChat;
}

export function geminiKeys(): string[] {
  const keys = (process.env.GOOGLE_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (process.env.GOOGLE_API_KEY && !keys.includes(process.env.GOOGLE_API_KEY)) keys.unshift(process.env.GOOGLE_API_KEY);
  return keys;
}

function makeModel(spec: ModelSpec) {
  if (spec.provider === "groq") {
    return new ChatOpenAI({
      model: spec.model,
      apiKey: process.env.GROQ_API_KEY,
      configuration: { baseURL: "https://api.groq.com/openai/v1" },
      temperature: 0,
      maxRetries: 0,
    });
  }
  // maxRetries 0: on a quota error we move to the next member instead of sleeping on this one.
  return new GeminiChat({ model: spec.model, apiKey: geminiKeys()[spec.keyIndex], temperature: 0, maxRetries: 0 });
}

/** Free-tier daily request caps observed for this account (Flash family: 20/day/project/model). */
function dailyBudget(model: string): number | null {
  const override = process.env[`RPD_${model.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`];
  if (override) return Number(override);
  if (/^gemini-[\d.]+-flash$|^gemini-3-flash-preview$/.test(model)) return 20;
  return null;
}

/**
 * Ordered reasoning pool: every model × every Gemini key (separate projects = separate quotas),
 * best model first. Override with REASONING_POOL="gemini:model,groq:model".
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
          "gemini:gemini-3-flash-preview",
          "gemini:gemini-3.1-flash-lite",
          "gemini:gemini-3.5-flash-lite",
          "gemini:gemma-4-26b-a4b-it",
          ...(process.env.GROQ_API_KEY ? ["groq:openai/gpt-oss-120b"] : []),
        ].join(","));
  const keyCount = Math.max(1, geminiKeys().length);
  const members: PoolMember[] = [];
  for (const entry of models.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [provider, ...rest] = entry.split(":");
    const model = rest.join(":");
    const keys = provider === "groq" ? 1 : keyCount;
    for (let k = 0; k < keys; k++) {
      const spec: ModelSpec = { provider: provider === "groq" ? "groq" : "gemini", model, keyIndex: k };
      members.push({ id: provider === "groq" ? model : `${model}@k${k + 1}`, spec, dailyBudget: dailyBudget(model), model: makeModel(spec) });
    }
  }
  return members;
}
