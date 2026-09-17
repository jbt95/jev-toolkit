// Test-only type stub for the Pi harness SDK.
//
// The Pi integration imports this module for types only; the real package is
// installed by Pi itself, not by this repo. Declaring the surface the extension
// uses lets the test import the shim without adding a runtime dependency.
declare module "@earendil-works/pi-coding-agent" {
  export interface ToolParams {
    readonly state: import("effect/Schema").Schema.Type<typeof import("effect/Schema").Schema.Json>;
    readonly questions: import("effect/Schema").Schema.Type<
      typeof import("effect/Schema").Schema.Json
    >;
    readonly model?: string;
  }

  export interface ToolExecuteResult {
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly details: Readonly<Record<string, never>>;
  }

  export interface ToolDefinition {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly promptSnippet: string;
    readonly promptGuidelines: ReadonlyArray<string>;
    readonly parameters: object;
    readonly execute: (toolCallId: string, params: ToolParams) => Promise<ToolExecuteResult>;
  }

  export interface ExtensionAPI {
    registerTool(definition: ToolDefinition): void;
    on(name: "input", handler: (event: { readonly text: string }) => void): void;
    on(
      name: "tool_result",
      handler: (event: { readonly isError: boolean; readonly content: string }) => void,
    ): void;
  }
}
