import "dotenv/config";

import { DuckDBInstance } from "@duckdb/node-api";
import { resolve, join } from "node:path";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");

const DB_PATH = join(
  DATA_DIR,
  "warehouse",
  "factures.duckdb"
);

async function main(): Promise<void> {
  console.log("================================");
  console.log(" REQUETES ANALYTIQUES");
  console.log("================================");

  const instance = await DuckDBInstance.create(DB_PATH);
  const db = await instance.connect();

  const queries = [
    {
      name: "Nombre de factures par statut",
      sql: `
        SELECT
          status,
          COUNT(*) AS nombre
        FROM silver.invoices
        GROUP BY status
        ORDER BY nombre DESC
      `
    },
    {
      name: "Montant TTC par fournisseur",
      sql: `
        SELECT
          supplier,
          COUNT(*) AS nombre_factures,
          SUM(total_ttc_cents) / 100.0 AS total_ttc_euros
        FROM silver.invoices
        GROUP BY supplier
        ORDER BY total_ttc_euros DESC
      `
    },
    {
      name: "Factures en retard de 2025",
      sql: `
        SELECT
          invoice_number,
          supplier,
          client,
          issue_date,
          total_ttc_cents / 100.0 AS total_ttc_euros
        FROM silver.invoices
        WHERE status = 'En retard'
          AND YEAR(issue_date) = 2025
        ORDER BY issue_date
      `
    },
    {
      name: "Total TTC des factures en retard de 2025",
      sql: `
        SELECT
          COUNT(*) AS nombre_factures,
          COALESCE(
            SUM(total_ttc_cents), 0
          ) / 100.0 AS total_ttc_euros
        FROM silver.invoices
        WHERE status = 'En retard'
          AND YEAR(issue_date) = 2025
      `
    },
    {
      name: "Contrôle des montants",
      sql: `
        SELECT
          invoice_number,
          total_ht_cents + total_vat_cents
            AS total_calcule_cents,
          total_ttc_cents AS total_facture_cents
        FROM silver.invoices
        WHERE ABS(
          total_ht_cents
          + total_vat_cents
          - total_ttc_cents
        ) > 1
      `
    }
  ];

  try {
    for (const query of queries) {
      console.log(`\n[QUERY] ${query.name}`);
      console.log(query.sql.trim());

      const reader = await db.runAndReadAll(query.sql);

      const rows = reader.getRowObjectsJson();

      console.log("[RESULT]");
      console.log(JSON.stringify(rows, null, 2));

      console.log(`[ROWS] ${rows.length}`);
    }
  } finally {
    db.disconnectSync();
    instance.closeSync();
  }
}

main().catch(error => {
  console.error(
    "[ERROR]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
