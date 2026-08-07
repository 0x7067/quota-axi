import { AxiError } from "axi-sdk-js";
import { MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { parseProviders } from "./providers/index.js";
import type { IntelligenceBucket, ModelSortKey, ProviderId } from "./types.js";

export type QuotaFlags = {
  providers: ProviderId[];
  json: boolean;
  full: boolean;
  tui: boolean;
  allowKeychainPrompt: boolean;
};

export type ModelsFlags = QuotaFlags & {
  intelligence?: IntelligenceBucket;
  sort?: ModelSortKey;
};

/**
 * Parse the flags shared by the `quota` and `auth` commands. Command routing is
 * owned by {@link runAxiCli}; this only interprets the flags that follow.
 * `--full` is accepted by both commands but only consumed by `quota`.
 */
export function parseFlags(args: string[]): QuotaFlags {
  const flags = parseCommonFlags(args);
  if (flags.intelligence !== undefined || flags.sort !== undefined) {
    throw new AxiError(
      "--intelligence and --sort are only supported by the models command",
      "VALIDATION_ERROR",
      ["Run `quota-axi models --help` for supported models flags"],
    );
  }
  return flags;
}

/** Parse flags accepted by the `models` evidence-join command. */
export function parseModelsFlags(args: string[]): ModelsFlags {
  const flags = parseCommonFlags(args, MODEL_CATALOG_PROVIDER_IDS);
  if (flags.tui) {
    throw new AxiError(
      "--tui is only supported by the quota command",
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui` for the human quota report"],
    );
  }
  const unsupported = flags.providers.find(
    (provider) => !MODEL_CATALOG_PROVIDER_IDS.includes(provider),
  );
  if (unsupported) {
    throw new AxiError(
      `models does not support provider: ${unsupported}`,
      "VALIDATION_ERROR",
      ["Supported model providers: claude, codex, grok, kimi"],
    );
  }
  return flags;
}

function parseCommonFlags(
  args: string[],
  defaultProviders?: readonly ProviderId[],
): ModelsFlags {
  let providerValue: string | undefined;
  let json = false;
  let full = false;
  let tui = false;
  let allowKeychainPrompt = false;
  let intelligence: IntelligenceBucket | undefined;
  let sort: ModelSortKey | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--tui") {
      tui = true;
      continue;
    }
    if (arg === "--allow-keychain-prompt") {
      allowKeychainPrompt = true;
      continue;
    }
    if (arg === "--intelligence") {
      intelligence = parseIntelligenceValue(args[index + 1], "--intelligence");
      index++;
      continue;
    }
    if (arg.startsWith("--intelligence=")) {
      intelligence = parseIntelligenceValue(
        arg.slice("--intelligence=".length),
        "--intelligence",
      );
      continue;
    }
    if (arg === "--sort") {
      sort = parseSortValue(args[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--sort=")) {
      sort = parseSortValue(arg.slice("--sort=".length));
      continue;
    }
    if (arg === "--provider") {
      const value = args[index + 1];
      if (!value) {
        throw new AxiError(
          "--provider requires a comma-separated provider list",
          "VALIDATION_ERROR",
          ["Pass --provider=... if the value begins with --"],
        );
      }
      providerValue = value;
      index++;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerValue = arg.slice("--provider=".length);
      continue;
    }
    throw new AxiError(`unknown argument: ${arg}`, "VALIDATION_ERROR", [
      "Run `quota-axi --help` for supported commands and flags",
    ]);
  }

  if (tui && json) {
    throw new AxiError(
      "--tui and --json are mutually exclusive output modes",
      "VALIDATION_ERROR",
      [
        "Run `quota-axi --tui` for the human report or `quota-axi --json` for machine output",
      ],
    );
  }

  return {
    providers:
      providerValue === undefined && defaultProviders
        ? [...defaultProviders]
        : parseProviderScope(providerValue),
    json,
    full,
    tui,
    allowKeychainPrompt,
    ...(intelligence ? { intelligence } : {}),
    ...(sort ? { sort } : {}),
  };
}

function parseIntelligenceValue(
  value: string | undefined,
  flag: string,
): IntelligenceBucket {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw new AxiError(
    `${flag} requires high, medium, or low`,
    "VALIDATION_ERROR",
    ["Run `quota-axi models --help` for supported models flags"],
  );
}

function parseSortValue(value: string | undefined): ModelSortKey {
  if (value === "runway") return value;
  throw new AxiError(
    "--sort requires a supported comparator",
    "VALIDATION_ERROR",
    ["Supported sort keys: runway"],
  );
}

function parseProviderScope(value: string | undefined): ProviderId[] {
  try {
    return parseProviders(value);
  } catch (error) {
    throw new AxiError(
      error instanceof Error ? error.message : "unsupported provider",
      "VALIDATION_ERROR",
      ["Supported providers: claude, codex, cursor, copilot, grok, kimi"],
    );
  }
}
