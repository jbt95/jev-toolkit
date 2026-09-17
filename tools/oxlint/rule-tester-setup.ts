import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

/**
 * RuleTester reads the ambient test framework from `globalThis`; vitest keeps
 * its API module-scoped, so hand RuleTester vitest's describe/it explicitly.
 * Referenced as a vitest setup file from vitest.config.ts.
 */
RuleTester.describe = describe;
RuleTester.it = it;
