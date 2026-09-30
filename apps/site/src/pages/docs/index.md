---
layout: ../../layouts/Docs.astro
eyebrow: Docs
title: Documentation
description: How to run Spaces on your own machine, and how it is built.
---

## Start here

- [**Self-host Spaces**](/docs/self-host). Requirements, the compose file, first run, HTTPS, backup and restore, upgrades, every setting, and local models with Ollama.
- [**Architecture**](/docs/architecture). The two processes, Postgres, blob storage, the repository layout and how the image is built and signed.

## In the repository

The decision record lives beside the code, in [`docs/` on GitHub](https://github.com/AnishxBadri/Spaces/tree/main/docs). It is written for contributors and is the deeper read:

- `ARCHITECTURE.md`, the whole system model by model.
- `CONTEXT.md` (at the repository root), every decision with its date and reasons, including the ones that were reversed.
- `roadmap-2026-09.md`, the projects in the order they were built.
- `design-contract.md` and `DESIGN.md`, the Instrument design system.
- The specs: `spec-plugin-sdk.md`, `spec-ai-substrate.md`, `spec-attribute-engine.md`, `spec-storage-sources.md`.

Spaces is AGPL-3.0. Issues and pull requests are welcome on [GitHub](https://github.com/AnishxBadri/Spaces).
