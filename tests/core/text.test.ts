import { describe, expect, it } from "vitest";
import { clip, redact } from "@/core/text.ts";

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
});
