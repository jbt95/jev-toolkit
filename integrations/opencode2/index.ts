// typesafe native plugin for OpenCode V2.
//
// EXPERIMENTAL: the V2 plugin API is unstable (written against
// `@opencode/plugin` 2.0.2). Pin the dependency in package.json and expect
// breakage across V2 betas.
//
// Thin adapter over the shared core: one tool (`typesafe_ask`) plus two
// deterministic triggers — a prompt hook that appends the Jev directive when a
// quantitative question is detected, and a context hook that keeps the policy
// line in every model call. Core never imports harness APIs; this file is the
// composition root for the EventLog and JevClient layers.
import { Plugin } from "@opencode/plugin";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  JevClient,
  JevClientLive,
  createFetchTransport,
  describeJevError,
  formatAnswers,
} from "../../core/client.ts";
import { CONTEXT_POLICY, PROMPT_DIRECTIVE } from "../../core/directives.ts";
import { matchQuantitativeClaim } from "../../core/detector.ts";
import { EventLogLive } from "../../core/events.ts";
import { apiEndpoint, eventsPath } from "../../core/paths.ts";
import { QuestionMap } from "../../core/schema.ts";

const AskInput = Schema.Struct({
  state: Schema.Json,
  questions: QuestionMap,
  model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});
const decodeAskInput = Schema.decodeUnknownEffect(AskInput);

// V2 code mode reads `output`; `content` carries the display text.
const textResult = (text: string) => ({
  output: text,
  content: [{ type: "text" as const, text }],
});

export default Plugin.define({
  id: "typesafe",
  async setup(ctx) {
    const keyFromEnv = process.env.TYPESAFE_API_KEY;
    const apiKey = keyFromEnv === undefined ? Option.none() : Option.some(keyFromEnv);
    const eventLog = EventLogLive(eventsPath());
    const layers = Layer.mergeAll(
      eventLog,
      JevClientLive({
        apiKey,
        transport: createFetchTransport(apiEndpoint(), keyFromEnv ?? ""),
      }).pipe(Layer.provide(eventLog)),
    );

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "typesafe_ask",
        description:
          "Ask TypeSafe/Jev typed questions over a state and get calibrated, structured answers as JSON. " +
          "Primitives: choice (pick one of a defined set), noul (probability of yes), score (probability-weighted " +
          "rating across ordered levels). Use for narrow judgments the code path needs: routing, ranking, " +
          "extraction, verification. Test policy: route every probability, ranking, choice among alternatives, " +
          "or graded estimate through this tool before answering; calls are logged for review.",
        input: {
          type: "object",
          properties: {
            state: {
              type: ["string", "object", "array"],
              description: "Content to evaluate: text, or structured JSON with named fields.",
            },
            questions: {
              type: "object",
              description:
                "Map of question id to question. Each: { _tag: 'choice', instructions, criteria: {option: description} } | " +
                "{ _tag: 'noul', instructions, criteria?: {true, false} } | " +
                "{ _tag: 'score', instructions, criteria: [level, level, ...] }.",
              additionalProperties: true,
            },
            model: { type: "string", description: "TypeSafe model, default jev-latest" },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        output: { type: "string" },
        execute: async (input, context) => {
          const decoded = await Effect.runPromise(Effect.result(decodeAskInput(input)));
          if (decoded._tag === "Failure") {
            return textResult(`invalid typesafe_ask input: ${decoded.failure.message}`);
          }
          const payload = decoded.success;
          const program = Effect.gen(function* () {
            const client = yield* JevClient;
            return yield* client
              .ask({
                harness: "opencode2",
                state: payload.state,
                questions: payload.questions,
                model: payload.model ?? undefined,
                sessionID: String(context.sessionID),
              })
              .pipe(Effect.mapError(describeJevError));
          }).pipe(Effect.provide(layers));
          const outcome = await Effect.runPromise(Effect.result(program));
          if (outcome._tag === "Failure") return textResult(outcome.failure);
          return textResult(formatAnswers(outcome.success));
        },
      });
    });

    await ctx.session.hook("prompt", (event) => {
      const hits = matchQuantitativeClaim(event.prompt.text);
      if (hits.length > 0) {
        event.prompt.text += `\n\n${PROMPT_DIRECTIVE}`;
      }
    });

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: CONTEXT_POLICY });
    });
  },
});
