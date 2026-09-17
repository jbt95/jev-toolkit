import { describe, expect, it } from "vitest";
import { matchQuantitativeClaim } from "@/core/detector.ts";

describe("matchQuantitativeClaim", () => {
  it("matches percentages, probability words, rankings, estimates, and choices", () => {
    expect(matchQuantitativeClaim("Coverage is 82%.")[0]?.pattern).toBe("percent");
    expect(matchQuantitativeClaim("That is likely true.")[0]?.pattern).toBe("probability");
    expect(matchQuantitativeClaim("I would rank option B first.")[0]?.pattern).toBe("ranking");
    expect(matchQuantitativeClaim("It costs roughly $40.")[0]?.pattern).toBe("estimate");
    expect(matchQuantitativeClaim("Should we ship this?")[0]?.pattern).toBe("choice");
  });

  it("ignores neutral prose", () => {
    expect(matchQuantitativeClaim("The build finished and the tests pass.")).toHaveLength(0);
  });

  it("reports the first match per pattern", () => {
    const matches = matchQuantitativeClaim("50% done, 80% remaining.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matched).toBe("50%");
  });
});
