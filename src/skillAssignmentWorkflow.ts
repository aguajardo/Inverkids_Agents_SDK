import { Agent, Runner, withTrace, hostedMcpTool } from "@openai/agents";
import { z } from "zod";
require("dotenv").config();

const SkillAssignmentOutputSchema = z.object({
  skill_ids: z.array(z.string()),
  rationale: z.string(),
});

const skillsCatalogMcp = hostedMcpTool({
  serverLabel: "Inverkids_Server",
  allowedTools: ["search_skills_by_keywords"],
  requireApproval: "never",
  serverUrl: "https://tools.inverkids.mx/mcp",
});

const skillAssignmentAgentInstructions = `You assign pedagogical skills (CHAs: competencias, habilidades, actitudes) to an activity component.

You receive a JSON payload with:
- activity: basic context about the parent activity (id, name, activity_type)
- frame: the content frame this component belongs to
- component: the specific component to assign skills to (id, component_type, data)

You do NOT receive the skills catalog directly in this payload — it is too large to
include inline. Instead, call the search_skills_by_keywords tool to retrieve the
skills that are relevant to this component.

HOW TO BUILD THE KEYWORDS:
Read the component's text/data and the activity name, and extract 3 to 6 single
Spanish words that describe what the component is about (topics, concepts, actions).
Example: a component asking students to count coins → ["dinero", "moneda", "contar"].
Example: a component about setting savings goals → ["ahorro", "meta", "dinero"].
If the component has very little text, derive keywords from the activity name instead.

RULES:
1. Call search_skills_by_keywords exactly ONCE per assignment, before deciding on skills.
2. Use the activity as context and the component as the specific focus of the assignment.
3. Choose only skill_id values that appear in the search_skills_by_keywords result. Never invent ids.
4. Choose the smallest set of skill_ids that accurately describe what this component assesses or develops.
5. If nothing in the returned skills reasonably applies, return an empty skill_ids array.
6. Do not call the tool more than once. Do not ask for clarification. Respond with the structured output only.`;

const skillAssignmentAgent = new Agent({
  name: "Component Skill Assignment Agent",
  instructions: skillAssignmentAgentInstructions,
  model: "gpt-4.1",
  tools: [skillsCatalogMcp],
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