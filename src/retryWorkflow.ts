import { Agent, Runner, withTrace } from "@openai/agents";
require("dotenv").config();

const retryAgent = new Agent({
  name: "Retry AI Agent",
  instructions: "Follow the request exactly as written.",
  model: "gpt-4.1",
  modelSettings: {
    temperature: 1,
    topP: 1,
    maxTokens: 8192,
    store: true,
  },
});

type RetryInput = { input_as_text: string };

function tokensOf(result: { rawResponses: any[] }) {
  const all = result.rawResponses ?? [];
  return {
    input_tokens: all.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
    output_tokens: all.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
  };
}

export const runRetryWorkflow = async (input: RetryInput) => {
  return await withTrace("Inverkids Retry AI Agent", async () => {
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_retry_ai_v1",
      },
    });

    const result = await runner.run(retryAgent, [
      {
        role: "user",
        content: [{ type: "input_text", text: input.input_as_text }],
      },
    ]);

    if (!result.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return {
      output_text: result.finalOutput,
      meta: tokensOf(result),
    };
  });
};