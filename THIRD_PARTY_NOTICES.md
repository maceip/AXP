# Third-party notices

- Agent Host Protocol, Microsoft Corporation, MIT:
  https://github.com/microsoft/agent-host-protocol
- Agent Client Protocol TypeScript SDK, Zed Industries, Apache-2.0:
  https://github.com/agentclientprotocol/typescript-sdk
- Agent Asynchronous Messaging Protocol specification and reference SDK,
  Lark Technologies Ltd., MIT: https://github.com/larksuite/aamp
- Nodemailer, Andris Reinman and contributors, MIT-0:
  https://github.com/nodemailer/nodemailer
- Huabu, Microsoft Corporation, MIT: https://github.com/microsoft/Huabu
  Adapted design tokens and tab component retain their source notices and
  license in `ui/src/vendor/huabu` and the built UI license directory.
- Pierre Diffs and Trees, The Pierre Computer Company, Apache-2.0:
  https://github.com/pierrecomputer/pierre
- React, Meta Platforms and affiliates, MIT: https://github.com/facebook/react
- Lucide, Lucide contributors, ISC: https://github.com/lucide-icons/lucide
- React Markdown and remark-gfm, unified contributors, MIT:
  https://github.com/remarkjs/react-markdown and https://github.com/remarkjs/remark-gfm
- beautiful-mermaid, Craft Docs, MIT: https://github.com/lukilabs/beautiful-mermaid.
  Vendored with the AXP "kawaii" edits in `ui/vendor/beautiful-mermaid`;
  its license sits beside the source. It depends on ELK (Eclipse Layout
  Kernel, EPL-2.0: https://github.com/kieler/elkjs) and entities (BSD-2-Clause),
  whose texts the UI build collects.
- Pretext (`@chenglou/pretext`), Pretext contributors, MIT:
  https://github.com/chenglou/pretext. Measures diagram labels with the real
  font and wraps long ones into balanced lines.
- DM Sans and IBM Plex Mono font packages, SIL Open Font License 1.1:
  https://fontsource.org/fonts/dm-sans and https://fontsource.org/fonts/ibm-plex-mono

The UI build collects the full license texts of its bundled dependencies and
their runtime dependency graph into `dist/ui/licenses/bundled.txt`.

AXP depends on these upstream packages. It is an independent project and is
not endorsed by Microsoft, Zed, Google, or any model provider. Dependency
licenses accompany their respective packages. Copied conformance fixtures
and the copied action schema retain the upstream MIT license beside them.

Design references:

- AHP doctrine: https://microsoft.github.io/agent-host-protocol/guide/doctrine
- ReasoningBank: https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- Memory Bank: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/generate-memories
- MTPLX: https://github.com/youssofal/MTPLX
