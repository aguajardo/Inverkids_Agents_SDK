import express from "express";
import "dotenv/config";
import { runWorkflow } from "./workflow";
import { runSkillAssignmentWorkflow } from "./skillAssignmentWorkflow";
import { runRetryWorkflow } from "./retryWorkflow";
import { randomUUID } from "crypto";
import { logRequest } from "./requestLog";

const app = express();
app.use(express.json({ limit: "5mb" }));

// Middleware simple para validar secret (opcional pero recomendado)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  const expected = `Bearer ${process.env.AI_AGENT_SECRET}`;

  if (!authHeader || authHeader !== expected) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  next();
});

// Temp Prefix S
type RequestSource = "teacher" | "alternatives" | "unknown";

const TEACHER_PREFIXES = ["Solicitud de actividad de aprendizaje", "Learning activity request"];
const ALTERNATIVES_PREFIX = "You generate alternative component configs";

function detectSource(inputAsText: unknown): RequestSource {
  const text = typeof inputAsText === "string" ? inputAsText.trimStart() : "";
  if (text.startsWith(ALTERNATIVES_PREFIX)) return "alternatives";
  if (TEACHER_PREFIXES.some((prefix) => text.startsWith(prefix))) return "teacher";
  return "unknown";
}
// Temp Prefix E

app.post("/run", async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();
  const inputChars = req.body?.input_as_text?.length ?? 0;
  const source = detectSource(req.body?.input_as_text);

  // Temp Prefix S
  if (source === "alternatives") {
    logRequest({ request_id: requestId, route: "/run", source, status: "rejected", duration_ms: Date.now() - started, input_chars: inputChars });
    return res.status(422).json({ message: "Component alternatives are not supported on /run" });
  }
  // Temp Prefix E

  try {
    const result: any = await runWorkflow(req.body);
    logRequest({ request_id: requestId, route: "/run", source, status: result.blocked ? "blocked" : "ok", duration_ms: Date.now() - started, input_chars: inputChars, ...result.meta });
    res.status(result.blocked ? 422 : 200).json(result);
  } catch (error: any) {
    console.error("Workflow error:", error);
    logRequest({ request_id: requestId, route: "/run", source, status: "error", duration_ms: Date.now() - started, error: error?.message, input_chars: inputChars });
    res.status(500).json({ message: "Workflow failed" });
  }
});

app.post("/run/assign-skills", async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();
  const inputChars = req.body?.input_as_text?.length ?? 0;
  try {
    const result = await runSkillAssignmentWorkflow(req.body);
    logRequest({ request_id: requestId, route: "/run/assign-skills", status: "ok", duration_ms: Date.now() - started, input_chars: inputChars });
    res.json(result);
  } catch (error: any) {
    console.error("Skill assignment workflow error:", error);
    logRequest({ request_id: requestId, route: "/run/assign-skills", status: "error", duration_ms: Date.now() - started, error: error?.message, input_chars: inputChars });
    res.status(500).json({ message: "Skill assignment workflow failed" });
  }
});

app.post("/run/retry", async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();
  const inputChars = req.body?.input_as_text?.length ?? 0;
  try {
    const result = await runRetryWorkflow(req.body);
    logRequest({ request_id: requestId, route: "/run/retry", source: "alternatives", status: "ok", duration_ms: Date.now() - started, input_chars: inputChars, ...result.meta });
    res.json(result);
  } catch (error: any) {
    console.error("Retry workflow error:", error);
    logRequest({ request_id: requestId, route: "/run/retry", source: "alternatives", status: "error", duration_ms: Date.now() - started, error: error?.message, input_chars: inputChars });
    res.status(500).json({ message: "Retry workflow failed" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`AI Agent running on port ${PORT}`);
});
