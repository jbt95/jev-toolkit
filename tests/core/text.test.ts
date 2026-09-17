import { describe, expect, it } from "vitest";
import { clip, redact, stripFencedCode } from "@/core/text.ts";

describe("text redaction and clipping", () => {
  it("masks authorization headers", () => {
    const redacted = redact('curl -H "Authorization: Bearer abc123" https://x');
    expect(redacted).not.toContain("abc123");
    expect(redacted).toContain("Authorization: [redacted]");
  });

  it("masks _TOKEN/_KEY/_SECRET assignments", () => {
    expect(redact("GITHUB_TOKEN=ghp_secretvalue")).toBe("GITHUB_TOKEN=[redacted]");
    expect(redact("export API_KEY=sk-123")).toBe("export API_KEY=[redacted]");
  });

  it("clips long text with a marker", () => {
    const clipped = clip("x".repeat(50), 10);
    expect(clipped.startsWith("x".repeat(10))).toBe(true);
    expect(clipped).toContain("… [clipped]");
    expect(clip("short", 10)).toBe("short");
  });

  it("strips fenced code blocks and marks the cut", () => {
    const raw = "Before\n```ts\nconst x = 1;\n```\nAfter";
    const stripped = stripFencedCode(raw);
    expect(stripped).toContain("Before");
    expect(stripped).toContain("After");
    expect(stripped).toContain("[code]");
    expect(stripped).not.toContain("const x = 1;");
  });

  it("keeps inline code and unterminated fences do not swallow everything", () => {
    expect(stripFencedCode("Use `npm test` first.")).toBe("Use `npm test` first.");
    const unterminated = stripFencedCode("Intro\n```\nraw code");
    expect(unterminated).toContain("Intro");
    expect(unterminated).not.toContain("raw code");
  });
});
