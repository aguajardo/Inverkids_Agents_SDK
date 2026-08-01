import { Agent, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
require("dotenv").config();

const SkillAssignmentOutputSchema = z.object({
  skill_ids: z.array(z.string()),
  rationale: z.string(),
});

const skillAssignmentAgentInstructions = `You assign pedagogical skills (CHAs: competencias, habilidades, actitudes) to an activity component.

You receive a JSON payload with:
- activity: basic context about the parent activity (id, name, activity_type)
- frame: the content frame this component belongs to
- component: the specific component to assign skills to (id, component_type, data)
- skills_catalog: the full list of valid skills to choose from, each with skill_id, description, ambito, subambito, skill_type

RULES:
1. Use the activity as context and the component as the specific focus of the assignment.
2. Choose only skill_id values that appear in the provided skills_catalog. Never invent ids.
3. Choose the smallest set of skill_ids that accurately describe what this component assesses or develops.
4. If nothing in the catalog reasonably applies, return an empty skill_ids array.
5. Do not call any tools. Do not ask for clarification. Respond with the structured output only.`;

const skillAssignmentAgent = new Agent({
  name: "Component Skill Assignment Agent",
  instructions: skillAssignmentAgentInstructions,
  model: "gpt-4.1",
  outputType: SkillAssignmentOutputSchema,
  modelSettings: {
    temperature: 0.2,
    topP: 1,
    maxTokens: 1024,
    store: true,
  },
});

type SkillAssignmentInput = { input_as_text: string };

export const runSkillAssignmentWorkflow = async (input: SkillAssignmentInput) => {
  return await withTrace("Inverkids Skill Assignment Agent", async () => {
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_skill_assignment_v1",
      },
    });

    const result = await runner.run(skillAssignmentAgent, [
      {
        role: "user",
        content: [{ type: "input_text", text: input.input_as_text }],
      },
    ]);

    if (!result.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return {
      output_text: JSON.stringify(result.finalOutput),
      output_parsed: result.finalOutput,
    };
  });
};