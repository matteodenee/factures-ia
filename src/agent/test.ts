import "dotenv/config";

import { connectMcp } from "./mcp-client.js";

async function main() {
  console.log("================================");
  console.log(" TEST CLIENT MCP");
  console.log("================================");

  const client = await connectMcp();

  try {
    const { tools } = await client.listTools();

    console.log("\nOutils disponibles :");

    for (const tool of tools) {
      console.log(`[TOOL] ${tool.name}`);
    }

    if (tools.length !== 5) {
      throw new Error(
        `Nombre d'outils incorrect : ${tools.length}`
      );
    }

    const result = await client.callTool({
      name: "execute_readonly_sql",
      arguments: {
        sql: `
          SELECT
            COUNT(*) AS nombre_factures,
            SUM(total_ttc_cents) / 100.0 AS montant_total
          FROM silver.invoices
        `
      }
    });

    if (result.isError) {
      throw new Error(
        JSON.stringify(result.content)
      );
    }

    console.log("\nRésultat SQL :");
    console.log(
      JSON.stringify(result.content, null, 2)
    );

    console.log("\n[OK] Communication MCP validée");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error("[ERROR]", error);
  process.exitCode = 1;
});
