import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
require("dotenv").config();

const allowlist = require("./allowlist.json") as Record<string, string[] | string>;

type TextUnit = {
  resource_id: string;
  kind: string;
  name_es: string | null;
  module_id: string | null;
  module_name: string | null;
  topic_id: string | null;
  topic_name: string | null;
  lang: "es" | "en";
  at: string;
  component: string;
  text: string;
};

type Finding = {
  code: string;
  severity: "alta" | "media" | "baja";
  kind: string;
  id: string;
  name_es: string | null;
  module_id: string | null;
  topic_id: string | null;
  location: { lang: string; frame: number | null; at: string; component: string };
  detail: string;
  suggestion?: string;
};

const FindingSchema = z.object({
  at: z.string().describe("El campo at exacto de la unidad donde esta el error"),
  code: z.enum(["SPELLING", "GRAMMAR_CLARITY"]),
  severity: z.enum(["alta", "media", "baja"]),
  problem: z.string().describe("Que esta mal, en una frase"),
  current_text: z.string().describe("El fragmento exacto con el error"),
  suggested_text: z.string().describe("El mismo fragmento corregido"),
});

const ReviewSchema = z.object({ findings: z.array(FindingSchema) });

const terms = Object.entries(allowlist)
  .filter(([key]) => !key.startsWith("_"))
  .flatMap(([, value]) => (Array.isArray(value) ? value : []))
  .join(", ");

const instructions = `Eres corrector editorial del contenido educativo de Inverkids.

Recibes las cadenas de texto de UN recurso (actividad o texto) en UN idioma, cada una con
su identificador "at". Revisas SOLO dos dimensiones:

A. ORTOGRAFIA: acentuacion, mayusculas y minusculas, puntuacion, erratas, palabras
   incompletas, duplicaciones accidentales.
B. GRAMATICA Y CLARIDAD: concordancia, construccion agramatical, frases ambiguas,
   instrucciones que no se entienden.

REGLAS INNEGOCIABLES:
1. No es error una eleccion estilistica valida. Si el texto ya esta bien escrito, no lo toques.
   Antes de reportar preguntate: un corrector profesional lo marcaria como ERROR, o solo
   lo escribiria distinto? Si es lo segundo, no lo reportes. NO son errores:
   - pasado simple en vez de presente perfecto ("Laura classified her coins" es correcto);
   - singular o plural cuando ambos son validos ("from lower value to higher value");
   - poner mayuscula a palabras que no son nombre propio ni inicio de frase;
   - espacios al inicio o al final de una cadena.
2. No reescribas por preferencia personal. Corrige solo cuando haya una mejora clara en
   correccion o comprension. "problem" describe exactamente el cambio que hace
   "suggested_text"; si no coinciden, no reportes el hallazgo.
3. No juzgues pedagogia, dificultad, duracion, ni si la respuesta marcada es la correcta.
4. No marques como error estos terminos: ${terms}.
5. Tampoco nombres propios de personas o lugares, etiquetas HTML, URLs, ni nombres de
   archivo o de imagen (por ejemplo "moneda_real_dos").
6. El texto en ingles se revisa con reglas del ingles y el espanol con reglas del espanol.
   Que una cadena este en el idioma equivocado NO es tu hallazgo: otro check ya lo detecta.
7. "at" se copia EXACTAMENTE como viene en la unidad. Nunca lo inventes.
8. "current_text" debe ser una subcadena literal del texto recibido.
9. Severidad: alta si la frase es agramatical o no se entiende lo que se le pide al alumno
   (por ejemplo "Which bill is the has the HIGHEST value?"), media si estorba la lectura,
   baja si es cosmetico.
10. Si no hay errores, devuelve findings vacio. Es una respuesta valida y esperada.
11. "problem" se escribe siempre en espanol, aunque el texto revisado este en ingles:
    lo lee el equipo pedagogico.`;

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const reviewAgent = new Agent({
  name: "Inverkids Content Grammar Reviewer",
  instructions,
  model: arg("model") ?? "gpt-4.1-mini",
  outputType: ReviewSchema,
  modelSettings: { temperature: 0, topP: 1, maxTokens: 2048, store: true },
});

const VerdictSchema = z.object({
  rule: z.string().describe("La regla de ortografia o gramatica que el original viola; vacio si no viola ninguna"),
  verdict: z.enum(["error", "estilo"]),
});

const verifierInstructions = `Eres el segundo revisor del contenido educativo de Inverkids. Otro corrector
propuso una correccion y tu trabajo es intentar TUMBARLA.

Recibes el idioma, el texto original completo, el fragmento senalado, la correccion
propuesta y el problema que describio el primer corrector.

Responde "error" solo si el fragmento original viola una regla objetiva del idioma,
y escribe esa regla en "rule". Ejemplos de regla: falta la tilde en una palabra aguda
terminada en n; hay una palabra duplicada; la frase no tiene un verbo valido; en ingles
no se usa el signo de apertura "¿"; el sujeto y el verbo no concuerdan.

Responde "estilo", con "rule" vacio, si el original es correcto y la correccion solo lo
dice distinto: mas claro, mas formal, mas natural, con otra puntuacion opcional (como la
coma antes de "or" o despues de una oracion subordinada), otro tiempo verbal valido, otra
palabra equivalente.

Las MAYUSCULAS son estilo salvo dos casos: falta la mayuscula al inicio de una oracion o
en un nombre propio. Cualquier otra cosa es estilo: mayusculas en titulos ("Let's Go
Shopping"), en vinetas o etiquetas ("Spend your money"), o palabras en mayusculas para
dar enfasis ("HIGHEST", "LOWEST"). Nunca existe una regla que pida poner una palabra
comun en mayuscula a mitad de frase.

Juzga el original, no la calidad de la correccion. Ante la duda, "estilo".
"rule" se escribe siempre en espanol: lo lee el equipo pedagogico.`;

const verifierAgent = new Agent({
  name: "Inverkids Content Grammar Verifier",
  instructions: verifierInstructions,
  model: arg("verifier-model") ?? "gpt-4.1-mini",
  outputType: VerdictSchema,
  modelSettings: { temperature: 0, topP: 1, maxTokens: 256, store: true },
});

const PLACEHOLDER_VALUE = /^\s*(default|random\s*\d+)\s*$/i;

const HIDDEN_FIELDS: [component: string, field: string][] = [
  ["turn-talk", "name"],
  ["hidden-objects", "nombre"],
];

const isHidden = (unit: TextUnit): boolean =>
  HIDDEN_FIELDS.some(([component, field]) => unit.component === component && unit.at.endsWith(`.${field}`));

const isKnownPattern = (unit: TextUnit): boolean =>
  /\bdefinition\./.test(unit.at) || PLACEHOLDER_VALUE.test(unit.text) || isHidden(unit);

const normalizeSpaces = (text: string): string => text.replace(/\s+/g, " ").trim();

// "frame=4 comp=2 questions.0.question" -> 4
const frameOf = (at: string): number | null => {
  const match = /frame=(\d+)/.exec(at);
  return match ? Number(match[1]) : null;
};

const readUnits = (file: string): TextUnit[] =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TextUnit);

// Un grupo = un recurso en un idioma: el modelo juzga el texto junto y con contexto,
// no cadena por cadena suelta.
const groupUnits = (units: TextUnit[]): TextUnit[][] => {
  const groups = new Map<string, TextUnit[]>();

  for (const unit of units) {
    const key = `${unit.resource_id}|${unit.lang}`;
    const current = groups.get(key) ?? [];
    current.push(unit);
    groups.set(key, current);
  }

  return [...groups.values()];
};

type Discard = { recurso: string | null; lang: string; motivo: string; at: string };
const discarded: Discard[] = [];

const usage = { input_tokens: 0, output_tokens: 0 };

const countUsage = (result: { rawResponses?: { usage?: { inputTokens?: number; outputTokens?: number } }[] }): void => {
  for (const response of result.rawResponses ?? []) {
    usage.input_tokens += response.usage?.inputTokens ?? 0;
    usage.output_tokens += response.usage?.outputTokens ?? 0;
  }
};

type Check = { idioma: string; texto_original: string; fragmento: string; correccion: string; problema: string };

const verdicts = new Map<string, Promise<string | null>>();

const verify = (runner: Runner, check: Check): Promise<string | null> => {
  const key = JSON.stringify([check.idioma, check.texto_original, check.fragmento]);
  const cached = verdicts.get(key);
  if (cached) return cached;

  const pending = askVerifier(runner, check);
  verdicts.set(key, pending);
  pending.catch(() => verdicts.delete(key));
  return pending;
};

const askVerifier = async (runner: Runner, check: Check): Promise<string | null> => {
  const result = await runner.run(verifierAgent, [
    { role: "user", content: [{ type: "input_text", text: JSON.stringify(check) }] },
  ]);

  countUsage(result);

  if (!result.finalOutput) throw new Error("el verificador no devolvio salida estructurada");
  return result.finalOutput.verdict === "error" ? result.finalOutput.rule : null;
};

const reviewGroup = async (runner: Runner, group: TextUnit[]): Promise<Finding[]> => {
  const head = group[0];
  const payload = {
    recurso: head.name_es,
    modulo: head.module_name,
    tema: head.topic_name,
    idioma: head.lang,
    unidades: group.map((unit) => ({ at: unit.at, componente: unit.component, texto: unit.text })),
  };

  const result = await runner.run(reviewAgent, [
    { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload, null, 2) }] },
  ]);

  countUsage(result);

  const output = result.finalOutput;
  if (!output) throw new Error("el modelo no devolvio salida estructurada");

  const byAt = new Map(group.map((unit) => [unit.at, unit]));
  const seen = new Set<string>();

  const candidates = output.findings.flatMap((finding): { finding: Finding; check: Check }[] => {
    const duplicateKey = `${finding.at}|${finding.current_text}`;
    if (seen.has(duplicateKey)) {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "duplicado", at: finding.at });
      return [];
    }
    seen.add(duplicateKey);

    const unit = byAt.get(finding.at);
    if (!unit) {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "at inexistente", at: finding.at });
      return [];
    }
    if (finding.current_text.trim().length === 0) {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "texto citado vacio", at: finding.at });
      return [];
    }
    if (!unit.text.includes(finding.current_text)) {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "texto citado no literal", at: finding.at });
      return [];
    }
    if (normalizeSpaces(finding.suggested_text) === normalizeSpaces(finding.current_text)) {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "sugerencia igual al original", at: finding.at });
      return [];
    }

    return [
      {
        finding: {
          code: finding.code,
          severity: finding.severity,
          kind: unit.kind,
          id: unit.resource_id,
          name_es: unit.name_es,
          module_id: unit.module_id,
          topic_id: unit.topic_id,
          location: { lang: unit.lang, frame: frameOf(unit.at), at: unit.at, component: unit.component },
          detail: `${finding.problem} - "${finding.current_text}" -> "${finding.suggested_text}"`,
          suggestion: finding.suggested_text,
        },
        check: {
          idioma: unit.lang,
          texto_original: unit.text,
          fragmento: finding.current_text,
          correccion: finding.suggested_text,
          problema: finding.problem,
        },
      },
    ];
  });

  if (flag("no-verify")) return candidates.map(({ finding }) => finding);

  const verified: Finding[] = [];
  for (const { finding, check } of candidates) {
    const rule = await verify(runner, check);
    if (rule !== null) {
      verified.push({ ...finding, detail: `${finding.detail} (regla: ${rule})` });
    } else {
      discarded.push({ recurso: head.name_es, lang: head.lang, motivo: "verificador: estilo", at: finding.location.at });
    }
  }

  return verified;
};

const main = async (): Promise<void> => {
  const input = arg("input");

  if (!input) {
    console.error(
      "Uso: npm run audit:grammar -- --input=<texto_para_llm.jsonl> [--out=<gramatica.json>] [--limit=N] [--concurrency=N] [--lang=es] [--model=gpt-4.1-mini] [--verifier-model=gpt-4.1-mini] [--no-verify] [--dry-run]"
    );
    process.exit(1);
    return;
  }

  const lang = arg("lang");
  const units = readUnits(input).filter((unit) => (!lang || unit.lang === lang) && !isKnownPattern(unit));
  let groups = groupUnits(units);

  const limit = Number(arg("limit") ?? 0);
  if (limit > 0) groups = groups.slice(0, limit);

  const chars = units.reduce((total, unit) => total + unit.text.length, 0);
  console.log(
    `unidades: ${units.length} | grupos (recurso x idioma): ${groups.length} | caracteres: ${chars} | tokens aprox: ${Math.round(chars / 4)}`
  );

  if (flag("dry-run")) {
    console.log("dry-run: no se llamo al modelo.");
    return;
  }

  const runner = new Runner({ traceMetadata: { workflow_id: "wf_content_grammar_v1" } });
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 3));
  const findings: Finding[] = [];
  const failures: { recurso: string | null; lang: string; error: string }[] = [];
  const queue = [...groups];
  let done = 0;
  const RATE_LIMIT_RETRIES = 3;
  const RATE_LIMIT_WAIT_MS = 20_000;
  const rateLimitAttempts = new Map<TextUnit[], number>();
  let aborted = false;

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (!aborted && queue.length > 0) {
      const group = queue.shift();
      if (!group) break;

      try {
        findings.push(...(await reviewGroup(runner, group)));
      } catch (error) {
        const { status, code } = error as { status?: number; code?: string };
        const attempts = (rateLimitAttempts.get(group) ?? 0) + 1;

        if (status === 429 && code === "rate_limit_exceeded" && attempts <= RATE_LIMIT_RETRIES) {
          rateLimitAttempts.set(group, attempts);
          console.warn(`limite de velocidad en ${group[0].name_es} (${group[0].lang}): reintento ${attempts}/${RATE_LIMIT_RETRIES} en ${RATE_LIMIT_WAIT_MS / 1000} s`);
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
          queue.push(group);
          continue;
        }

        failures.push({
          recurso: group[0].name_es,
          lang: group[0].lang,
          error: (error as Error).message,
        });
        console.error(`error en ${group[0].name_es} (${group[0].lang}):`, (error as Error).message);
        if (status === 429) aborted = true;
      }

      done += 1;
      if (done % 10 === 0) console.log(`  ${done}/${groups.length} grupos`);
    }
  });

  await Promise.all(workers);

  const out = arg("out") ?? path.join(path.dirname(input), "checks", "gramatica.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const byCode = findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.code] = (acc[finding.code] ?? 0) + 1;
    return acc;
  }, {});

  const reviewed = done - failures.length;
  const skipped = queue.length;

  console.log(`grupos revisados: ${reviewed}/${groups.length}`);
  console.log("hallazgos:", byCode);
  const byVerifier = discarded.filter((item) => item.motivo.startsWith("verificador")).length;
  console.log(`descartados por las defensas: ${discarded.length - byVerifier} | tumbados por el verificador: ${byVerifier}`);
  console.log(`tokens: entrada ${usage.input_tokens} | salida ${usage.output_tokens}`);

  if (failures.length > 0 || skipped > 0) {
    const partial = `${out.replace(/\.json$/, "")}.parcial.json`;
    fs.writeFileSync(
      partial,
      JSON.stringify(
        { revisados: reviewed, fallidos: failures.length, sin_revisar: skipped, usage, findings, failures, discarded },
        null,
        2
      ),
      "utf8"
    );

    if (aborted) console.error(`\nSe corto la corrida por un 429: ${skipped} grupos quedaron sin revisar.`);
    console.error(`\n${failures.length} de ${groups.length} grupos fallaron: la revision esta incompleta.`);
    console.error(`NO se escribio ${path.basename(out)}. Resultado parcial en: ${partial}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(out, JSON.stringify(findings, null, 2), "utf8");
  if (discarded.length > 0) {
    fs.writeFileSync(`${out.replace(/\.json$/, "")}.descartes.json`, JSON.stringify(discarded, null, 2), "utf8");
  }
  console.log("salida:", out);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});