import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { SplitchBrowserClient } from "../browser/client";
import { getBrowserClientInternalAccess } from "../browser/client-internals";
import { SplitchSdkError } from "../errors";
import type { VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";

export interface SplitchProviderProps {
  readonly client: SplitchBrowserClient;
  readonly children?: ReactNode;
}

interface ProviderValue {
  readonly client: SplitchBrowserClient;
  readonly decorationEligible: { current: boolean };
}

const SplitchContext = createContext<ProviderValue | null>(null);

export function SplitchProvider({ client, children }: SplitchProviderProps): ReactElement {
  const decorationEligible = useRef(false);
  useEffect(() => {
    decorationEligible.current = true;
    return () => {
      decorationEligible.current = false;
    };
  }, []);
  const value = useMemo(() => ({ client, decorationEligible }), [client]);
  return createElement(SplitchContext.Provider, { value }, children);
}

export function useSplitchClient(): SplitchBrowserClient {
  return useProviderValue().client;
}

export function useFlag(flagKey: string, defaultValue: VariantValue): VariantValue {
  return useHeldResolution(flagKey, defaultValue).resolution.details.value;
}

export function useFlagDetails(flagKey: string, defaultValue: VariantValue): SdkResolutionDetails {
  const { provider, access, resolution } = useHeldResolution(flagKey, defaultValue);
  const decorated = useRef<{
    readonly held: SdkResolutionDetails;
    readonly degraded: boolean;
    readonly details: SdkResolutionDetails;
  } | null>(null);

  if (!provider.decorationEligible.current) {
    return resolution.details;
  }
  const degraded = access.readRevalidationDegraded();
  const memoized = decorated.current;
  if (memoized !== null && memoized.held === resolution.details && memoized.degraded === degraded) {
    return memoized.details;
  }
  const details =
    resolution.kind === "entry"
      ? access.decorateHeldDetails(
          resolution.details.value,
          resolution.details.variantName,
          resolution.details.reason,
          degraded,
        )
      : resolution.details;
  decorated.current = { held: resolution.details, degraded, details };
  return details;
}

function useHeldResolution(flagKey: string, defaultValue: VariantValue) {
  const provider = useProviderValue();
  const { client } = provider;
  const access = getBrowserClientInternalAccess(client);
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.subscribe(flagKey, onStoreChange),
    [client, flagKey],
  );
  const getSnapshot = useCallback(() => access.readHeldEntry(flagKey), [access, flagKey]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const resolution = useMemo(
    () => getBrowserClientInternalAccess(client).deriveHeldResolution(flagKey, entry, defaultValue),
    [client, entry, flagKey, defaultValue],
  );
  const latestDefault = useRef(defaultValue);
  latestDefault.current = defaultValue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new held entry arms its new Exposure Ticket for the committed read
  useEffect(() => {
    client.evaluate(flagKey, latestDefault.current);
  }, [client, entry, flagKey]);
  return { provider, access, resolution };
}

function useProviderValue(): ProviderValue {
  const value = useContext(SplitchContext);
  if (value === null) {
    throw new SplitchSdkError({
      code: "SDK_REACT_PROVIDER_MISSING",
      causeSummary: "A React binding hook rendered outside SplitchProvider",
      remediation: "Wrap the component tree in SplitchProvider and pass a browser client",
    });
  }
  return value;
}
