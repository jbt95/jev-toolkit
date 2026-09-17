import { describe, expect, it } from "vitest";
import { transcriptFailureCandidates } from "@/core/transcript.ts";

const entry = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          is_error: true,
          content: [{ type: "text", text }],
        },
      ],
    },
  });

describe("claude transcript failure candidates", () => {
  it("extracts nested error text newest first", () => {
    const raw = ['{"type":"assistant"}', entry("first failure"), entry("second failure")].join(
      "\n",
    );
    expect(transcriptFailureCandidates(raw)).toEqual(["second failure", "first failure"]);
  });

  it("handles string content and deduplicates", () => {
    const stringEntry = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "plain error" }] },
    });
    const raw = [stringEntry, entry("plain error")].join("\n");
    expect(transcriptFailureCandidates(raw)).toEqual(["plain error"]);
  });

  it("falls back to raw is_error lines for unknown shapes", () => {
    const raw = '{"custom":{"is_error":true,"text":"boom"}}';
    expect(transcriptFailureCandidates(raw)).toEqual([raw]);
  });

  it("returns nothing when no failing entry exists", () => {
    expect(transcriptFailureCandidates('{"type":"assistant","message":{"content":[]}}')).toEqual(
      [],
    );
  });
});
