import "dotenv/config";

import assert from "node:assert/strict";
import { connectMcp } from "./mcp-client.js";

async function main(): Promise<void> {
  const client = await connectMcp();

  try {
    console.log("================================");
    console.log(" TEST DES STATUTS MCP");
    console.log("================================");

    const result = await client.callTool({
      name: "list_invoices",
      arguments: {
        status: "En retard",
        year: 2025,
        limit: 20
      }
    });

    if (result.isError) {
      throw new Error(
        `Erreur MCP : ${JSON.stringify(result.content)}`
      );
    }

    const content = result.content;

    assert.ok(Array.isArray(content));

    const text = content.find(
      item => item.type === "text"
    );

    assert.ok(text && text.type === "text");

    const data = JSON.parse(text.text);

    assert.ok(Array.isArray(data.rows));

    const rows = data.rows;

    console.log("\nFactures trouvées :");

    for (const row of rows) {
      console.log(
        `[FACTURE] ${row.invoice_number} | ` +
        `${row.client} | ${row.total_ttc_euros} EUR`
      );
    }

    const total = rows.reduce(
      (
        sum: number,
        row: { total_ttc_euros: number | string }
      ) => sum + Number(row.total_ttc_euros),
      0
    );

    console.log(`\nNombre : ${rows.length}`);
    console.log(`Total TTC : ${total.toFixed(2)} EUR`);

    assert.equal(rows.length, 12);

    assert.ok(
      Math.abs(total - 106886.43) < 0.01
    );

    console.log("\n[OK] Filtrage MCP corrigé");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(
    "[ERROR]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
