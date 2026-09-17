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

  it("masks quoted JSON authorization, lowercase names, and bare bearer tokens", () => {
    expect(redact('{"authorization": "Bearer abc123"}')).not.toContain("abc123");
    expect(redact("github_token=ghp_secretvalue")).toBe("github_token=[redacted]");
    expect(redact("db_password=hunter2")).toBe("db_password=[redacted]");
    expect(redact("curl -H 'Bearer abc123'")).not.toContain("abc123");
  });

  it("masks camelCase and bare credential keys without over-redacting prose", () => {
    expect(redact('{"apiKey": "sk-live-123"}')).not.toContain("sk-live-123");
    expect(redact('{"token": "abc123"}')).not.toContain("abc123");
    expect(redact("githubToken=ghp_secretvalue")).toBe("githubToken=[redacted]");
    expect(redact("monkey: banana")).toBe("monkey: banana");
  });

  it("masks mixed-case bearer tokens and unquoted values containing commas", () => {
    expect(redact("curl -H 'bearer abc123def'")).not.toContain("abc123def");
    expect(redact("password=abc,def")).toBe("password=[redacted]");
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
