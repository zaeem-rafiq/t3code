/**
 * AntigravityAdapter — shape type for the Antigravity provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/AntigravityDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module AntigravityAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AntigravityAdapterShape — per-instance Antigravity adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface AntigravityAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
