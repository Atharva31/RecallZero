# RecallZero Recall Coordinator

![domain:food-safety](https://img.shields.io/badge/food--safety-3D8BD3) ![tech:uagents](https://img.shields.io/badge/uagents-3D8BD3) ![chat-protocol](https://img.shields.io/badge/chat--protocol-3D8BD3)

Executes food product recalls across a supply chain. Tell it which ingredient lot is contaminated and it:

1. Traces every finished product made from that lot and every warehouse and store that received it.
2. Authorizes the recall and opens one containment task per affected store.
3. Sends quarantine requests to each connected store's retailer agent; manual stores confirm at their store terminal.
4. Blocks checkout sales of quarantined lots.
5. Escalates stores that do not answer instead of assuming they are contained.
6. Replies with a final report that separates verified containment from sold, lost, unaccounted and unknown units.

Every state change is a deterministic database reducer. The language model only reads your request and writes the report from committed records.

## Example

> Start an investigation for contaminated ingredient PEANUT-009 and contain it.

Replies: the affected lots and stores, live updates as stores verify or escalate, then the final recall report.

## Input

A chat message naming the contaminated lot ID (for example `PEANUT-009`) and optionally the hazard (Salmonella, Listeria, allergen, ...).
