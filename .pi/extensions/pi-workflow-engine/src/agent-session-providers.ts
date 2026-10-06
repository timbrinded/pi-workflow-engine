import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

type HostProviderRegistry = Pick<
  ModelRegistry,
  | "getApiKeyForProvider"
  | "getProviderAuthStatus"
  | "getRegisteredProviderConfig"
  | "getRegisteredProviderIds"
  | "isUsingOAuth"
> & {
  /** pi 1.x keeps providers registered as objects (`pi.registerProvider(provider)`) apart from config providers. */
  getRegisteredNativeProvider?(providerId: string): unknown;
};

type ChildModelRuntime = ModelRuntime & { registerNativeProvider?(provider: unknown): void };

/** Mirror the host's live provider and selected-model auth state into a child runtime. */
export async function synchronizeWorkflowModelRuntime(input: {
  readonly host: HostProviderRegistry;
  readonly child: ChildModelRuntime;
  readonly selectedModel: Model<Api> | undefined;
  readonly removeChildOnlyProviders: boolean;
}): Promise<void> {
  const { host, child, selectedModel, removeChildOnlyProviders } = input;
  const hostProviderIds = new Set(host.getRegisteredProviderIds());

  if (removeChildOnlyProviders) {
    for (const providerId of child.getRegisteredProviderIds()) {
      if (!hostProviderIds.has(providerId)) child.unregisterProvider(providerId);
    }
  }

  for (const providerId of hostProviderIds) {
    const config = host.getRegisteredProviderConfig(providerId);
    if (config) {
      child.unregisterProvider(providerId);
      child.registerProvider(providerId, config);
      continue;
    }
    const native = host.getRegisteredNativeProvider?.(providerId);
    if (native && child.registerNativeProvider) {
      child.unregisterProvider(providerId);
      child.registerNativeProvider(native);
    }
  }

  const selectedProvider = selectedModel?.provider;
  if (!selectedModel || !selectedProvider) return;

  const hostAuth = host.getProviderAuthStatus(selectedProvider);
  const childAuth = child.getProviderAuthStatus(selectedProvider);
  if (hostAuth.configured && !childAuth.configured && host.isUsingOAuth(selectedModel)) {
    throw new Error(
      `Workflow subagents cannot inherit OAuth credentials for "${selectedProvider}" from a host-only credential store; configure OAuth in Pi's shared agent directory.`,
    );
  }
  if (hostAuth.source === "runtime" || (hostAuth.configured && !childAuth.configured)) {
    const apiKey = await host.getApiKeyForProvider(selectedProvider);
    if (apiKey !== undefined) await child.setRuntimeApiKey(selectedProvider, apiKey);
  }
}
