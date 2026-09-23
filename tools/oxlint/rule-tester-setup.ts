import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

RuleTester.describe = describe;
RuleTester.it = it;
