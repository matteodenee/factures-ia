import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { connectMcp } from "./mcp-client.js";
import {
  reliableAnswer,
  type InvoiceFilter
} from "./reliable.js";

type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type LlmResponse = {
  choices?: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
};

const API_URL = process.env.AGENT_API_URL;
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL;

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const TRACE_DIR = join(DATA_DIR, "agent");

const SYSTEM_PROMPT = `
Tu es un assistant spécialisé dans l'analyse de factures.

Tu réponds en français à partir des données réelles.

Règles :
- Utilise les outils MCP pour obtenir les informations.
- Ne fabrique jamais de factures, de montants ou de statistiques.
- Consulte get_schema si tu ne connais pas les colonnes SQL.
- Utilise execute_readonly_sql pour les agrégations complexes.
- Les montants sont stockés en centimes dans DuckDB.
- Pour les nombres de factures et montants totaux, utilise
  prioritairement invoice_summary avec les filtres appropriés.
- Ne calcule jamais toi-même une somme financière.
- Reprends exactement le montant retourné par DuckDB.
- Si un résultat d'outil contient déjà un total TTC en euros,
  utilise directement cette valeur.
- Ne modifie jamais les chiffres reçus d'un outil.

- Convertis les montants en euros pour l'utilisateur.
- Explique lorsqu'une information est indisponible.
- Ne prétends jamais avoir exécuté un outil sans l'avoir appelé.
- Reste concis et précis.
`;

async function trace(
  sessionId: string,
  event: unknown
): Promise<void> {
  await mkdir(TRACE_DIR, { recursive: true });

  await appendFile(
    join(TRACE_DIR, `${sessionId}.jsonl`),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event as object
    }) + "\n"
  );
}

async function askLlm(
  messages: Message[],
  tools: unknown[],
  toolChoice: "auto" | "required" = "auto"
): Promise<NonNullable<LlmResponse["choices"]>[number]["message"]> {
  if (!API_URL || !MODEL) {
    throw new Error(
      "AGENT_API_URL et AGENT_MODEL doivent être configurés"
    );
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY
        ? { Authorization: `Bearer ${API_KEY}` }
        : {})
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: 0
    }),
    signal: AbortSignal.timeout(120000)
  });

  const raw = await response.text();

  let data: LlmResponse;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Réponse LLM non JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Erreur LLM HTTP ${response.status}: ` +
      (data.error?.message || "Erreur inconnue")
    );
  }

  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error("Réponse LLM sans message");
  }

  return message;
}

async function main(): Promise<void> {
  if (!API_URL || !MODEL) {
    console.error(
      "[ERROR] Configure AGENT_API_URL et AGENT_MODEL dans .env"
    );
    process.exitCode = 1;
    return;
  }

  const client = await connectMcp();
  const rl = createInterface({ input: stdin, output: stdout });

  const sessionId = `session-${Date.now()}`;

  const messages: Message[] = [{
    role: "system",
    content: SYSTEM_PROMPT
  }];

  let lastInvoiceFilter: InvoiceFilter | null = null;

  try {
    const { tools: mcpTools } = await client.listTools();

    const tools = mcpTools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema
      }
    }));

    console.log("================================");
    console.log(" AGENT IA - FACTURES");
    console.log("================================");
    console.log(`Modèle : ${MODEL}`);
    console.log(`Outils MCP : ${tools.length}`);
    console.log(`Session : ${sessionId}`);
    console.log("Commande de sortie : quitter");

    while (true) {
      let question: string;

      try {
        question = (await rl.question("\nVous > ")).trim();
      } catch (error) {
        const code = (
          error as { code?: string }
        )?.code;

        if (code === "ERR_USE_AFTER_CLOSE") {
          break;
        }

        throw error;
      }

      if (!question) {
        continue;
      }

      if (["quitter", "exit", "quit"].includes(question.toLowerCase())) {
        break;
      }

      messages.push({
        role: "user",
        content: question
      });

      await trace(sessionId, {
        type: "question",
        question
      });

      try {
        const reliable = await reliableAnswer(
          client,
          question,
          lastInvoiceFilter
        );

        if (reliable) {
          lastInvoiceFilter = reliable.filter;

          console.log("[MCP] " + reliable.tool);
          console.log("\nAgent > " + reliable.answer);

          messages.push({
            role: "assistant",
            content: reliable.answer
          });

          await trace(sessionId, {
            type: "tool_call",
            tool: reliable.tool,
            arguments: JSON.stringify(reliable.arguments),
            result: reliable.result
          });

          await trace(sessionId, {
            type: "answer",
            answer: reliable.answer
          });

          continue;
        }

        let completed = false;

        for (let step = 0; step < 6; step++) {
          const answer = await askLlm(
            messages,
            tools,
            step === 0 ? "required" : "auto"
          );

          messages.push({
            role: "assistant",
            content: answer.content,
            ...(answer.tool_calls
              ? { tool_calls: answer.tool_calls }
              : {})
          });

          const calls = answer.tool_calls || [];

          if (calls.length === 0) {
            if (step === 0) {
              console.error(
                "[BLOCKED] Réponse sans consultation MCP"
              );

              messages.splice(1);
              completed = true;
              break;
            }

            const finalAnswer =
              answer.content?.trim() ||
              "Je n'ai pas pu produire de réponse.";

            console.log(`\nAgent > ${finalAnswer}`);

            await trace(sessionId, {
              type: "answer",
              answer: finalAnswer
            });

            completed = true;
            break;
          }

          for (const call of calls) {
            console.log(`[MCP] ${call.function.name}`);

            let result: unknown;

            try {
              const args = JSON.parse(
                call.function.arguments || "{}"
              );

              const toolResult = await client.callTool({
                name: call.function.name,
                arguments: args
              });

              result = toolResult;

              if (toolResult.isError) {
                console.error(
                  `[MCP ERROR] ${call.function.name}`
                );
              }
            } catch (error) {
              result = {
                isError: true,
                error: error instanceof Error
                  ? error.message
                  : String(error)
              };
            }

            await trace(sessionId, {
              type: "tool_call",
              tool: call.function.name,
              arguments: call.function.arguments,
              result
            });

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result)
            });
          }
        }

        if (!completed) {
          console.log(
            "\nAgent > Limite d'appels atteinte pour cette question."
          );

          // Évite de conserver un historique incomplet.
          messages.splice(1);
        }
      } catch (error) {
        console.error(
          "[ERROR]",
          error instanceof Error ? error.message : String(error)
        );

        // Une erreur ne doit pas polluer la conversation suivante.
        messages.splice(1);
      }
    }
  } finally {
    rl.close();
    await client.close();
  }
}

main().catch(error => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
