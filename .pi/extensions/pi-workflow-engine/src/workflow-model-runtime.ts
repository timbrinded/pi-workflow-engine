import {
  ModelRuntime,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

type RegisteredProviderRegistry = Pick<
  ModelRegistry,
  "getRegisteredProviderConfig" | "getRegisteredProviderIds"
>;

interface InheritedProvider {
  readonly hostConfig: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
  readonly runtimeConfig: ReturnType<ModelRuntime["getRegisteredProviderConfig"]>;
  readonly removable: boolean;
}

/**
 * Create one run-scoped model runtime and synchronize host-only provider
 * registrations before every child session builds its own services.
 */
export function createWorkflowModelRuntimeAccessor(
  hostRegistry: RegisteredProviderRegistry,
  existing?: ModelRuntime,
): () => Promise<ModelRuntime> {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  let serialized: Promise<void> = Promise.resolve();
  const inherited = new Map<string, InheritedProvider>();

  return () => {
    const request = serialized.then(async () => {
      runtimePromise ??= existing ? Promise.resolve(existing) : ModelRuntime.create();
      const runtime = await runtimePromise;
      synchronizeRegisteredProviders(runtime, hostRegistry, inherited);
      return runtime;
    });
    serialized = request.then(() => undefined, () => undefined);
    return request;
  };
}

function synchronizeRegisteredProviders(
  runtime: ModelRuntime,
  hostRegistry: RegisteredProviderRegistry,
  inherited: Map<string, InheritedProvider>,
): void {
  const providerIds = new Set(hostRegistry.getRegisteredProviderIds());

  for (const [providerId, previous] of inherited) {
    if (providerIds.has(providerId)) continue;
    if (previous.removable && runtime.getRegisteredProviderConfig(providerId) === previous.runtimeConfig) {
      runtime.unregisterProvider(providerId);
    }
    inherited.delete(providerId);
  }

  for (const providerId of providerIds) {
    const hostConfig = hostRegistry.getRegisteredProviderConfig(providerId);
    const previous = inherited.get(providerId);
    if (!hostConfig || previous?.hostConfig === hostConfig) continue;
    const runtimeConfigBefore = runtime.getRegisteredProviderConfig(providerId);
    // Pass through pi's supported provider facade as a whole. Credential and
    // OAuth resolution remain inside ModelRuntime; no secret fields are read.
    runtime.registerProvider(providerId, hostConfig);
    inherited.set(providerId, {
      hostConfig,
      runtimeConfig: runtime.getRegisteredProviderConfig(providerId),
      removable: previous
        ? previous.removable && runtimeConfigBefore === previous.runtimeConfig
        : runtimeConfigBefore === undefined,
    });
  }
}
