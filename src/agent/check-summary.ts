import "dotenv/config";

import assert from "node:assert/strict";
import { connectMcp } from "./mcp-client.js";

async function main(): Promise<void> {
  const client = await connectMcp();

  try {
    const result = await client.callTool({
      name: "invoice_summary",
      arguments: {
        status: "En retard",
        year: 2025
      }
    });

    assert.ok(!result.isError, "Erreur MCP");

    assert.ok(Array.isArray(result.content));

    const text = result.content.find(
      item => item.type === "text"
    );

    assert.ok(text && text.type === "text");

    const data = JSON.parse(text.text);
    const row = data.rows[0];

    console.log("================================");
    console.log(" TEST AGREGATION MCP");
    console.log("================================");

    console.log("Nombre :", row.invoice_count);
    console.log("Total TTC :", row.total_ttc_euros, "EUR");
    console.log("SQL :", data.sql.trim());

    assert.equal(Number(row.invoice_count), 2);

    assert.ok(
      Math.abs(Number(row.total_ttc_euros) - 29762.70) < 0.01
    );

    console.log("\n[OK] Agregation MCP correcte");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error("[ERROR]", error);
  process.exitCode = 1;
});
