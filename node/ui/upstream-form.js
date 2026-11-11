export const DEFAULT_PACING = {
  enabled: false,
  minStartIntervalMs: 0,
  modelIntervals: [],
  maxQueueDepth: 20,
  maxQueueAgeMs: 30000
};

export function upstreamSavePayload(values) {
  const data = {
    ...values,
    pacing: {
      ...DEFAULT_PACING,
      ...(values.pacing || {}),
      modelIntervals: (values.pacing?.modelIntervals || [])
        .map((entry) => ({ model: String(entry.model || '').trim(), minStartIntervalMs: entry.minStartIntervalMs ?? 0 }))
        .filter((entry) => entry.model)
    }
  };
  if (!data.authJson) delete data.authJson;
  if (!data.accessToken) delete data.accessToken;
  if (!data.projectKey) delete data.projectKey;
  if (data.type !== 'codex') delete data.allowProviderCredits;
  return data;
}
