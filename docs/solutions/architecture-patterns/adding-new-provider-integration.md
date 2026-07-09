---
title: Adding a New Provider Integration (e.g., Google Antigravity)
date: 2026-07-08
category: architecture-patterns
module: provider-integration
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Integrating a new external AI provider, CLI tool, or Model Context Protocol (MCP) runtime"
tags:
  - provider-integration
  - architecture
  - mcp
  - cli-adapter
---

# Adding a New Provider Integration (e.g., Google Antigravity)

## Context

The T3 Code application required integration with the Google Antigravity (`agy`) provider. This involved bridging the gap between the application's internal architecture (Contracts, Backend Driver & Adapter Infrastructure, Web UI) and the external `agy` CLI for authentication, model generation, and ACP (Agent Context Protocol) session orchestration. Additionally, the integration needed to handle strict concurrency requirements and thread locking constraints when orchestrating interactions between the CLI runtime and the application.

## Guidance

When adding a new CLI-based provider to the T3 Code architecture, follow a strict multi-layered implementation pattern:

1. **Contracts & Schemas (`packages/contracts`)**:
   - Register the provider's unique identifier using the branded type `ProviderDriverKind.make("<provider-name>")`.
   - Define the configurable settings schema (e.g., `AntigravitySettings`).
   - Expose the provider name in `PROVIDER_DISPLAY_NAMES`.

2. **Backend Infrastructure (`apps/server`)**:
   - **Provider**: Implement health and authentication checks (e.g., `AntigravityProvider.ts` calling `agy auth status`).
   - **Adapter**: Implement the `AcpSessionRuntime` (e.g., `AntigravityAdapter.ts`) to orchestrate interactions between the CLI runtime and the app. Carefully orchestrate interactions and enforce strict concurrency safety/thread locking when spawning and managing the CLI process (e.g., `agy mcp`).
   - **Text Generation**: Bridge stateless model generation calls to the CLI (e.g., `AntigravityTextGeneration.ts` via `agy --headless`).
   - **Driver**: Hook up the components in a driver factory (e.g., `AntigravityDriver.ts`) and register it in `builtInDrivers.ts`.

3. **Frontend Plumbing (`apps/web`)**:
   - Register the provider in `PROVIDER_CLIENT_DEFINITIONS` so it appears in the Settings UI and model selectors.
   - Add the necessary iconography in `PROVIDER_ICON_BY_PROVIDER` (e.g., inside `providerIconUtils.ts`) for chat rendering. Ensure proper model slug normalization (e.g., `resolveAntigravityAcpBaseModelId`).

## Why This Matters

Following this layered architecture ensures that the application remains modular, type-safe, and decoupled from the specific implementation details of the CLI tool. Correctly applying the `ProviderDriverKind` branded type prevents cross-package typecheck failures. Moreover, enforcing strict concurrency safety within the Adapter layer prevents race conditions and crashes during active ACP sessions. Failing to implement health checks in the Provider layer or mismanaging the CLI subprocesses can lead to orphaned processes, silent failures, and a degraded user experience.

## When to Apply

- "Integrating a new external AI provider, CLI tool, or Model Context Protocol (MCP) runtime"
- When the provider requires maintaining a persistent session or subprocess (like ACP) alongside stateless text generation calls.

## Examples

**Backend Wire-up (Driver):**
Create an `AntigravityDriver` that encapsulates the dependencies:

- Connects `AntigravityProvider` for health checks.
- Instantiates `AntigravityAdapter` for orchestrating the persistent `agy mcp` session.
- Plugs in `AntigravityTextGeneration` for stateless `agy --headless` calls.
  Register this driver in `apps/server/src/provider/builtInDrivers.ts`.

**Contract Branding:**
Using `ProviderDriverKind.make("antigravity")` to ensure the provider key is strictly typed across all boundaries.
