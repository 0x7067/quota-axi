import {
  compareModelsByRunway,
  SELECTION_SCALAR_KEY,
  type EffectiveAvailability,
  type ModelQuotaRecord,
  type ModelsResponse,
  type QuotaAxiResponse,
} from "quota-axi";

const quota: QuotaAxiResponse = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  schemaVersion: 4,
  providers: [],
};

const model: ModelQuotaRecord = {
  provider: "claude",
  id: "consumer-fixture",
  label: "Consumer fixture",
  intelligence: "high",
  quotaScopes: [],
  state: { status: "fresh", stale: false },
};

const models: ModelsResponse = {
  generatedAt: quota.generatedAt,
  schemaVersion: 1,
  catalog: { version: "2026-08-05", provenance: "consumer fixture" },
  models: [model],
};

const scope: EffectiveAvailability = {
  scope: "all_models",
  status: "known",
  boundedBy: [],
  selection: { status: "known", [SELECTION_SCALAR_KEY]: 1.5 },
};
const reclaimPriority: number | undefined =
  scope.selection?.[SELECTION_SCALAR_KEY];

void models;
void reclaimPriority;
void compareModelsByRunway(model, model);
