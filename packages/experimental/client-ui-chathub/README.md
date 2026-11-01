---
description: "Sidebar panel for ChatHub: browser providers, checkpointed model switching, and cross-provider sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-chathub

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds a ChatHub entry to the sidebar and the main panel it opens. The panel lists every browser-backed provider with its connection state, creates sessions bound to one provider, and shows each open conversation's messages. Switching a session's model runs the host's checkpointed handoff and records the switch in the session's provider history. Sessions, messages, and checkpoints live in the host's storage domain, so they survive a host restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [chathub-host bundle row](../chathub-host/README.md) on the Host, then open the ChatHub entry in the sidebar. The panel loads every provider's identity and connection state through the `chatHub` Remote; a provider that needs sign-in shows its state and a sign-in action that opens the site's login window through the `webChat` Remote. Create a session with a title, a task goal, and a starting provider; the session opens with an empty conversation. Type a message and press Enter to run one turn: the user message is stored first, the current provider answers, and the answer is stored with the turn. A failed turn keeps the user message, marks the session failed with a stable `provider: code` error, and writes no assistant message.

Switch a session's model from the switcher in the open conversation. The host writes a checkpoint, compiles the canonical context, renders the handoff prompt, and moves the session to the target provider before the next turn; the panel then shows the updated provider history as the ordered models the session has used. Deleting a session removes its messages, timeline, and checkpoints from the host's storage. After a host restart the panel restores every stored session with its persisted status.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The package is browser-only: its host entry is a marker, and the client entry mounts the generated `chathub-host` Remote before registering the panel and sidebar contributions. One store instance, created at registration, holds the provider list, session list, open conversation, and error state; the injected face translates every user action into `chatHub` or `webChat` Remote calls and writes the outcomes through store actions. Remote failures surface as the error line; the panel never renders raw site text because the host normalizes every failure to a stable code. The conversation composer sends optimistically: the user message renders immediately, and a failed turn leaves it in place with the error line set.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `chatHub` Remote the panel calls: it forwards user-authored messages and the localized switch reason, and the host controller owns the compiled context, the rendered handoff prompt, and the page dispatch.

#### KV Cache effect

The panel adds no content beyond what the user types and the switch reason; a cached request prefix changes only when the host's compiled context changes between turns, such as an edited goal or a recorded model switch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The panel polls no stream: a turn renders when its Remote call settles, so long answers appear whole instead of progressively.
- Provider sign-in requires a visible browser window; headless hosts cannot complete the interactive flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
