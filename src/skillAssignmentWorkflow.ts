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
- white_label and level: the brand catalog and the level (grade) this component belongs to; either may be null
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
   If the payload has non-null white_label and level, pass BOTH to the tool exactly as given
   (arguments white_label and level) so the results are restricted to skills of that level;
   only skills of that level will be accepted. If either is null, omit both arguments.
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

const INLINE_SKILLS_MARKER = "ALLOWED_SKILLS:";

const inlineSkillAssignmentAgentInstructions = `You assign pedagogical skills (CHAs: competencias, habilidades, actitudes) to an activity component.

The user message contains ALLOWED_SKILLS (one JSON object per line: skill_id, description, ambito, subambito)
and the COMPONENT to assign (activity context, frame kind, component type and data).

RULES:
1. Choose only skill_id values that appear in ALLOWED_SKILLS. Each one is a short code like "S001"; return it exactly as listed. Never invent ids.
2. Use the activity name only as context. Judge the component itself: what must a student actually do to answer it correctly?
3. Assign a skill only if answering the component directly requires or practises it. Sharing a topic or theme is not enough.
4. Never stretch a rationale to make a skill fit. If the link needs speculation, or the component has no instructions or content to judge, return an empty skill_ids array.
5. Assign at most 2 skill_ids, most relevant first. Usually one is enough.
6. Write the rationale in Spanish, in one or two sentences.
7. Do not ask for clarification. Respond with the structured output only.`;

const inlineSkillAssignmentAgent = new Agent({
  name: "Component Skill Assignment Agent (inline skills)",
  instructions: inlineSkillAssignmentAgentInstructions,
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

    const agent = input.input_as_text.includes(INLINE_SKILLS_MARKER) ? inlineSkillAssignmentAgent : skillAssignmentAgent;

    const result = await runner.run(agent, [
      {
        role: "user",
        content: [{ type: "input_text", text: input.input_as_text }],
      },
    ]);

    if (!result.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    // Token usage for cost tracking; cached_tokens is billed at a discount, so it is reported separately
    const usage = result.state.usage;
    const cachedTokens = usage.inputTokensDetails.reduce((sum, details) => sum + (details?.cached_tokens ?? 0), 0);

    return {
      output_text: JSON.stringify(result.finalOutput),
      output_parsed: result.finalOutput,
      usage: {
        model: String(agent.model),
        requests: usage.requests,
        input_tokens: usage.inputTokens,
        cached_tokens: cachedTokens,
        output_tokens: usage.outputTokens,
      },
    };
  });
};