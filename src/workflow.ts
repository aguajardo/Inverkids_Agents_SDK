import {
  hostedMcpTool,
  fileSearchTool,
  RunContext,
  Agent,
  AgentInputItem,
  Runner,
  withTrace,
} from "@openai/agents";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { z } from "zod";
require("dotenv").config();

// Tool definitions
const mcp = hostedMcpTool({
  serverLabel: "Inverkids_Server",
  allowedTools: ["generate_activity"],
  requireApproval: "never",
  serverUrl: "https://tools.inverkids.mx/mcp",
});
const fileSearch = fileSearchTool(["vs_696ed9e2f43c819182df51033c49775a"]);

// Shared client for guardrails and file search
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Guardrails definitions
const inverkidsGuardrailConfig = {
  guardrails: [
    {
      name: "Moderation",
      config: {
        categories: [
          "sexual/minors",
          "hate/threatening",
          "harassment/threatening",
          "self-harm/intent",
          "self-harm/instructions",
          "violence/graphic",
          "illicit/violent",
        ],
      },
    },
    {
      name: "Jailbreak",
      config: { model: "gpt-4.1-mini", confidence_threshold: 0.7 },
    },
    {
      name: "NSFW Text",
      config: { model: "gpt-4.1-mini", confidence_threshold: 0.7 },
    },
  ],
};
const context = { guardrailLlm: client };

function guardrailsHasTripwire(results: any[]): boolean {
  return (results ?? []).some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: any[], fallbackText: string): string {
  for (const r of results ?? []) {
    if (r?.info && "checked_text" in r.info) {
      return r.info.checked_text ?? fallbackText;
    }
  }
  const pii = (results ?? []).find(
    (r) => r?.info && "anonymized_text" in r.info
  );
  return pii?.info?.anonymized_text ?? fallbackText;
}

async function scrubConversationHistory(
  history: any[],
  piiOnly: any
): Promise<void> {
  for (const msg of history ?? []) {
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "input_text" &&
        typeof part.text === "string"
      ) {
        const res = await runGuardrails(part.text, piiOnly, context, true);
        part.text = getGuardrailSafeText(res, part.text);
      }
    }
  }
}

async function scrubWorkflowInput(
  workflow: any,
  inputKey: string,
  piiOnly: any
): Promise<void> {
  if (!workflow || typeof workflow !== "object") return;
  const value = workflow?.[inputKey];
  if (typeof value !== "string") return;
  const res = await runGuardrails(value, piiOnly, context, true);
  workflow[inputKey] = getGuardrailSafeText(res, value);
}

async function runAndApplyGuardrails(
  inputText: string,
  config: any,
  history: any[],
  workflow: any
) {
  const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
  const results = await runGuardrails(inputText, config, context, true);
  const shouldMaskPII = guardrails.find(
    (g) => g?.name === "Contains PII" && g?.config && g.config.block === false
  );
  if (shouldMaskPII) {
    const piiOnly = { guardrails: [shouldMaskPII] };
    await scrubConversationHistory(history, piiOnly);
    await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
    await scrubWorkflowInput(workflow, "input_text", piiOnly);
  }
  const hasTripwire = guardrailsHasTripwire(results);
  const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
  return {
    results,
    hasTripwire,
    safeText,
    failOutput: buildGuardrailFailOutput(results ?? []),
    passOutput: { safe_text: safeText },
  };
}

function buildGuardrailFailOutput(results: any[]) {
  const get = (name: string) =>
    (results ?? []).find(
      (r: any) => (r?.info?.guardrail_name ?? r?.info?.guardrailName) === name
    );
  const pii = get("Contains PII"),
    mod = get("Moderation"),
    jb = get("Jailbreak"),
    hal = get("Hallucination Detection"),
    nsfw = get("NSFW Text"),
    url = get("URL Filter"),
    custom = get("Custom Prompt Check"),
    pid = get("Prompt Injection Detection"),
    piiCounts = Object.entries(pii?.info?.detected_entities ?? {})
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => k + ":" + (v as unknown[]).length),
    conf = jb?.info?.confidence;
  return {
    pii: {
      failed: piiCounts.length > 0 || pii?.tripwireTriggered === true,
      detected_counts: piiCounts,
    },
    moderation: {
      failed:
        mod?.tripwireTriggered === true ||
        (mod?.info?.flagged_categories ?? []).length > 0,
      flagged_categories: mod?.info?.flagged_categories,
    },
    jailbreak: { failed: jb?.tripwireTriggered === true },
    hallucination: {
      failed: hal?.tripwireTriggered === true,
      reasoning: hal?.info?.reasoning,
      hallucination_type: hal?.info?.hallucination_type,
      hallucinated_statements: hal?.info?.hallucinated_statements,
      verified_statements: hal?.info?.verified_statements,
    },
    nsfw: { failed: nsfw?.tripwireTriggered === true },
    url_filter: { failed: url?.tripwireTriggered === true },
    custom_prompt_check: { failed: custom?.tripwireTriggered === true },
    prompt_injection: { failed: pid?.tripwireTriggered === true },
  };
}
const RequestNormalizerCurriculumSchema = z.object({
  academic_level: z.string(),
  learning_context: z.string(),
  common_student_errors: z.array(z.string()),
  success_criteria: z.string(),
  estimated_duration: z.number(),
  number_of_exercises: z.number(),
  language: z.string(),
  modules: z.array(z.string()),
  topics: z.array(z.string()),
  secondary_topic: z.string(),
  token: z.string(),
});
interface ActivityGeneratorPdfProducerContext {
  inputOutputText: string;
}
const activityGeneratorPdfProducerInstructions = (
  runContext: RunContext<ActivityGeneratorPdfProducerContext>,
  _agent: Agent<ActivityGeneratorPdfProducerContext>
) => {
  const { inputOutputText } = runContext.context;
  return `You are the Activity Generator Agent for the Inverkids platform.

You have ONE job: call generate_activity ONCE with the input provided.

--------------------------------------------------
INPUT
--------------------------------------------------

${inputOutputText}

--------------------------------------------------
AVAILABLE TOOLS
--------------------------------------------------

generate_activity — You may call this tool EXACTLY ONE TIME.

--------------------------------------------------
RULES
--------------------------------------------------

1. Call generate_activity ONCE using the input data.
2. After calling the tool, your task is complete regardless of the response.
3. You are NOT allowed to call generate_activity a second time under any circumstance.
4. Do not output text before or after the tool call.
5. Do not retry. Do not loop. Do not continue.

--------------------------------------------------
INTERNAL DESIGN (DO NOT OUTPUT)
--------------------------------------------------

Before calling the tool, silently design:
- One activity aligned with the provided topics
- Exercises matching number_of_exercises
- Duration matching estimated_duration

--------------------------------------------------
EXERCISE TYPE RULES — MANDATORY
--------------------------------------------------

Each exercise's \"type\" MUST be exactly one of:
  - \"multiple_choice\"
  - \"open_question\"
  - \"true_false\"
  - \"fill_in_the_blank\"
  - \"matching\"
  - \"short_answer\"
  - \"essay\"
  - \"ordering\"

Choose the type based on what the exercise actually asks the student to do:
  - Use \"multiple_choice\" ONLY if the student picks one answer from a
    fixed set of options you provide. It REQUIRES a non-empty \"options\"
    array with at least 3 distinct choices, and a \"correct_option\" field
    naming the correct one.
  - Use \"true_false\" ONLY for a binary true/false judgment. It REQUIRES
    \"options\": [\"true\", \"false\"] (or the localized equivalents) and a
    \"correct_option\".
  - Use \"open_question\", \"short_answer\", or \"essay\" when the student must
    write a free-text response with NO fixed set of choices. These types
    MUST NOT include an \"options\" or \"correct_option\" field — leave the
    exercise as just \"type\" and \"prompt\".
  - Use \"fill_in_the_blank\", \"matching\", or \"ordering\" only when the
    exercise structure genuinely matches that format.

Do NOT default to \"multiple_choice\" when you are unsure — if the exercise
has no natural fixed set of answer choices, it is an \"open_question\".
Never label an exercise \"multiple_choice\" without also generating its
\"options\" array; a multiple_choice exercise with no options is invalid.

--------------------------------------------------
TOOL CALL FORMAT
--------------------------------------------------

{
  \"name\": \"generate_activity\",
  \"arguments\": {
    \"token\": \"string\",
    \"activity\": {
      \"activity_language\": \"string\",
      \"title\": \"string\",
      \"grade_level\": 0,
      \"topic_scope\": \"string\",
      \"secondary_topic\": \"string\",
      \"activity_type\": \"string\",
      \"difficulty\": \"string\",
      \"structure\": { \"sections\": [\"string\"] },
      \"instructions\": \"string\",
      \"exercises\": [
        { \"type\": \"string\", \"prompt\": \"string\" },
        {
          \"type\": \"multiple_choice\",
          \"prompt\": \"string\",
          \"options\": [\"string\", \"string\", \"string\"],
          \"correct_option\": \"string\"
        }
      ],
      \"metadata\": {
        \"estimated_time_minutes\": 0,
        \"retry_allowed\": false
      }
    },
    \"teacher\": {
      \"instructions\": \"string\",
      \"answers\": [
        {
          \"exercise_index\": 0,
          \"expected_answer\": \"string\",
          \"grading_criteria\": \"string\"
        }
      ]
    },
    \"module_ids\": [\"string\"],
    \"topic_ids\": [\"string\"]
  }
}

--------------------------------------------------
AFTER THE TOOL RESPONDS
--------------------------------------------------

If the activity was created in Spanish, output only:
\"Actividad generada exitosamente.\"

If the activity was created in English, output only:
\"Activity successfully generated.\"

Nothing else. No explanations. No extra text.`;
};
const activityGeneratorPdfProducer = new Agent({
  name: "Activity Generator & PDF Producer",
  instructions: activityGeneratorPdfProducerInstructions,
  model: "gpt-4.1",
  tools: [mcp],
  modelSettings: {
    temperature: 0.75,
    topP: 1,
    maxTokens: 8000,
    store: true,
  },
});

const requestNormalizerCurriculum = new Agent({
  name: "Request Normalizer & Curriculum",
  instructions: `You are the Request Normalizer & Curriculum Scope Agent for the Inverkids platform.

Your sole responsibility is to:
- ANALYZE the teacher's request
- RETRIEVE the correct curriculum scope
- NORMALIZE all information into a single structured JSON object
to be passed to the Activity Generator Agent.

You do NOT:
- Generate activities
- Design pedagogical exercises
- Invent curriculum, topics, or tags

--------------------------------------------------
INPUT
--------------------------------------------------
You receive a teacher request containing:
- academic_level
- weak_topics (free text or selected)
- common_student_errors
- learning_context (reinforcement, remediation, practice)
- success_criteria
- estimated_duration
- number_of_exercises
- optional activity_preferences
- teacher_metadata

--------------------------------------------------
AVAILABLE TOOLS
--------------------------------------------------

Semantic retrieval (ONLY allowed tool for tag inference):
- Inverkids_Vector_Store

You MUST use Inverkids_Vector_Store to infer tags.

--------------------------------------------------
PROCESS (MANDATORY)
--------------------------------------------------

Step 1 — Semantic tag inference
- Use Inverkids_Vector_Store EXCLUSIVELY to semantically analyze:
  - weak_topics
  - common_student_errors
- Extract only tags that the vector store returns.
- Do NOT invent, assume, or supplement tags from memory.
- Do NOT use any other tool or knowledge source for this step.

Step 3 — Topic retrieval
- Call Inverkids_Vector_Store using ONLY the tags returned.
- Use pagination if needed.
- Explicitly EXCLUDE topics related to:
  - evaluations
  - diagnostics
  - summaries
  - final wrap-ups

--------------------------------------------------
SECONDARY TOPIC RULES — MANDATORY
--------------------------------------------------

The secondary_topic field MUST:
- Be 1 to 3 words MAXIMUM
- Be a short keyword or concept label
- NOT be a sentence, phrase, or explanation
- NOT exceed 25 characters
- Represent a complementary concept that enriches the primary topic
- Be derived ONLY from weak_topics or vector store results

VALID examples:
  \"ahorro\", \"presupuesto\", \"inflacion\", \"interes compuesto\", \"deuda\"

INVALID examples:
  \"El concepto de ahorro aplicado a la vida diaria del estudiante\"
  \"Temas relacionados con la gestión del dinero en el hogar\"
  \"How saving money can help students achieve their financial goals\"

If you cannot identify a valid short secondary topic, use the most
relevant single keyword from the weak_topics input.

--------------------------------------------------
OUTPUT (STRICT CONTRACT)
--------------------------------------------------

Return ONLY the following JSON object.
Do NOT add commentary, explanations, markdown, or extra fields.
Do NOT include any field not listed below.

{
  \"academic_level\": \"\",
  \"learning_context\": \"\",
  \"common_student_errors\": [],
  \"success_criteria\": \"\",
  \"estimated_duration\": 0,
  \"number_of_exercises\": 0,
  \"language\": \"\",
  \"modules\": [],
  \"topics\": [],
  \"secondary_topic\": \"\"
}

--------------------------------------------------
FAILURE CONDITIONS
--------------------------------------------------

If ANY of the following occur, STOP immediately and return
a structured error JSON. Do NOT guess or fill missing data.

- No modules found for the given level
- Inverkids_Vector_Store returns no valid tags
- No curriculum topics match the returned tags
- Required input fields are missing
- secondary_topic cannot be reduced to 3 words or fewer`,
  model: "gpt-4.1",
  tools: [fileSearch],
  outputType: RequestNormalizerCurriculumSchema,
  modelSettings: {
    temperature: 1,
    topP: 1,
    maxTokens: 2048,
    store: true,
  },
});

type WorkflowInput = { input_as_text: string };

// Main code entrypoint
export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Inverkids Agent", async () => {
    const state = {};
    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: workflow.input_as_text }],
      },
    ];
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_694190d744cc81909142f67e50d3acad05f3facb48842076",
      },
    });
    const guardrailsInputText = workflow.input_as_text;
    const {
      hasTripwire: guardrailsHasTripwire,
      safeText: guardrailsAnonymizedText,
      failOutput: guardrailsFailOutput,
      passOutput: guardrailsPassOutput,
    } = await runAndApplyGuardrails(
      guardrailsInputText,
      inverkidsGuardrailConfig,
      conversationHistory,
      workflow
    );
    const guardrailsOutput = guardrailsHasTripwire
      ? guardrailsFailOutput
      : guardrailsPassOutput;
    if (guardrailsHasTripwire) {
      return guardrailsOutput;
    } else {
      const requestNormalizerCurriculumResultTemp = await runner.run(
        requestNormalizerCurriculum,
        [...conversationHistory]
      );

      if (!requestNormalizerCurriculumResultTemp.finalOutput) {
        throw new Error("Agent result is undefined");
      }

      const requestNormalizerCurriculumResult = {
        output_text: JSON.stringify(
          requestNormalizerCurriculumResultTemp.finalOutput
        ),
        output_parsed: requestNormalizerCurriculumResultTemp.finalOutput,
      };
      const activityGeneratorPdfProducerResultTemp = await runner.run(
        activityGeneratorPdfProducer,
        [...conversationHistory],
        {
          context: {
            inputOutputText: requestNormalizerCurriculumResult.output_text,
          },
        }
      );
      conversationHistory.push(
        ...activityGeneratorPdfProducerResultTemp.newItems.map(
          (item) => item.rawItem
        )
      );

      if (!activityGeneratorPdfProducerResultTemp.finalOutput) {
        throw new Error("Agent result is undefined");
      }

      const activityGeneratorPdfProducerResult = {
        output_text: activityGeneratorPdfProducerResultTemp.finalOutput ?? "",
      };
      return activityGeneratorPdfProducerResult;
    }
  });
};
