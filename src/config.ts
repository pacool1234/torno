import { z } from "zod";

export type Config = {
  apiKey?: string;
  baseUrl: string;
  model: string;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-haiku-4-5";

const blankAsUnset = (value: unknown): unknown => (value === "" ? undefined : value);

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(blankAsUnset, z.string().optional()),
  ANTHROPIC_BASE_URL: z.preprocess(
    blankAsUnset,
    z
      .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
      .default(DEFAULT_BASE_URL),
  ),
  TORNO_MODEL: z.preprocess(blankAsUnset, z.string().default(DEFAULT_MODEL)),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  }

  const {
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    TORNO_MODEL: model,
  } = parsed.data;
  return { ...(apiKey === undefined ? {} : { apiKey }), baseUrl, model };
}
