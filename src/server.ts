import express from "express";
import "dotenv/config";
import { runWorkflow } from "./workflow";
import { runSkillAssignmentWorkflow } from "./skillAssignmentWorkflow";
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

app.post("/run", async (req, res) => {
  const started = Date.now();
  const requestId = randomUUID();
  try {
    const result: any = await runWorkflow(req.body);
    logRequest({ request_id: requestId, route: "/run", status: result.blocked ? "blocked" : "ok", duration_ms: Date.now() - started, input_chars: req.body?.input_as_text?.length ?? 0, ...result.meta });
    res.status(result.blocked ? 422 : 200).json(result);
  } catch (error: any) {
    console.error("Workflow error:", error);
    logRequest({request_id: requestId, route:"/run", status:"error", duration_ms: Date.now() - started, error: error?.message, input_chars: req.body?.input_as_text?.length ?? 0})
    res.status(500).json({ message: "Workflow failed" });
  }
});

app.post("/run/assign-skills", async (req, res) => {
  try {
    console.log("Received skill assignment request");
    const result = await runSkillAssignmentWorkflow(req.body);

    res.json(result);
  } catch (error: any) {
    console.error("Skill assignment workflow error:", error);
    res.status(500).json({ message: "Skill assignment workflow failed" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`AI Agent running on port ${PORT}`);
});
