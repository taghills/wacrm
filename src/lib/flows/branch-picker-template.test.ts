import { describe, it, expect } from "vitest";

import { getFlowTemplate } from "./templates";
import { validateFlowForActivation } from "./validate";

/**
 * The branch-picker template ships with empty `store_id`s on purpose
 * — store ids are per-account UUIDs a static template cannot know.
 *
 * These tests pin both halves of that bargain: the flow is otherwise
 * completely wired (no dangling edges, no orphan nodes, every branch
 * reaches a terminal node), and the ONLY thing standing between a
 * fresh clone and activation is picking the three stores.
 */
describe("branch_picker template", () => {
  const template = getFlowTemplate("branch_picker");

  it("exists and is triggered by a customer's first message", () => {
    expect(template).not.toBeNull();
    expect(template?.trigger_type).toBe("first_inbound_message");
  });

  it("asks once and offers one button per branch", () => {
    const ask = template?.nodes.find((n) => n.node_key === "ask_branch");
    const buttons = (ask?.config as { buttons?: unknown[] }).buttons ?? [];
    expect(buttons).toHaveLength(3);
    // Meta rejects a button title over 20 characters, and the failure
    // arrives at send time as an opaque 400 rather than at save time.
    for (const b of buttons as { title: string }[]) {
      expect(b.title.length).toBeLessThanOrEqual(20);
    }
  });

  it("routes every branch through its own assign-store step", () => {
    const assigns = template?.nodes.filter((n) => n.node_type === "set_store");
    expect(assigns).toHaveLength(3);
    for (const node of assigns ?? []) {
      expect((node.config as { next_node_key?: string }).next_node_key).toBe(
        "thanks",
      );
    }
  });

  it("is fully wired apart from the stores the operator must pick", () => {
    const issues = validateFlowForActivation(
      {
        name: template!.name,
        entry_node_id: template!.entry_node_id,
        trigger_type: template!.trigger_type,
        trigger_config: template!.trigger_config,
      } as never,
      template!.nodes as never,
    );

    const errors = issues.filter((i) => i.severity === "error");
    // Every remaining error is a missing store_id — nothing else.
    expect(errors.map((e) => e.field)).toEqual([
      "store_id",
      "store_id",
      "store_id",
    ]);
  });
});
