import { annotateQuotaAdvice } from "./advice.js";
import { parseFlags, parseModelsFlags } from "./args.js";
import { writeCachedProviders } from "./cache.js";
import { withQuotaSemantics } from "./interpretation.js";
import { createModelsResponse } from "./models.js";
import { nowIso } from "./lib/time.js";
import { PROVIDERS } from "./providers/index.js";
import {
  redactedResponse,
  renderAuthToon,
  renderModelsToon,
  renderQuotaToon,
} from "./render.js";
import type {
  AuthProviderReport,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  QuotaAxiResponse,
} from "./types.js";

export type QuotaContext = {
  binPath: string;
};

export async function quotaCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
  };

  const response = await fetchQuota(flags.providers, options);
  const redacted = redactedResponse(response, flags.full);

  if (response.providers.every(isFailed)) {
    process.exitCode = 1;
  }
  writeCachedProvidersBestEffort(response.providers);

  return flags.json
    ? JSON.stringify(redacted, null, 2)
    : renderQuotaToon(redacted, binPath, flags.full);
}

export async function modelsCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseModelsFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
  };
  const quota = await fetchQuota(flags.providers, options);
  writeCachedProvidersBestEffort(quota.providers);
  const response = createModelsResponse(quota, {
    ...(flags.intelligence ? { intelligence: flags.intelligence } : {}),
    ...(flags.sort ? { sort: flags.sort } : {}),
  });

  if (quota.providers.every(isFailed)) process.exitCode = 1;
  return flags.json
    ? JSON.stringify(response, null, 2)
    : renderModelsToon(response, binPath, flags.full);
}

export async function authCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
  };

  const reports = await inspectAuth(flags.providers, options);
  return flags.json
    ? JSON.stringify(
        { generatedAt: nowIso(), schemaVersion: 1, auth: reports },
        null,
        2,
      )
    : renderAuthToon(reports, binPath);
}

export async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<QuotaAxiResponse> {
  const generatedAt = nowIso();
  const results = (
    await Promise.all(
      providers.map((provider) => PROVIDERS[provider].fetchQuota(options)),
    )
  ).map((provider) => withQuotaSemantics(provider, generatedAt));
  return annotateQuotaAdvice({
    generatedAt,
    providers: results,
  });
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  return Promise.all(
    providers.map((provider) => PROVIDERS[provider].inspectAuth(options)),
  );
}

function isFailed(provider: ProviderQuota): boolean {
  return !["fresh", "stale"].includes(provider.state.status);
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}
