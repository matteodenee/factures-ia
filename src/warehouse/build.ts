import "dotenv/config";

import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const WAREHOUSE_DIR = join(DATA_DIR, "warehouse");
const DB_PATH = join(WAREHOUSE_DIR, "factures.duckdb");

function sqlPath(path: string): string {
  return path.replace(/'/g, "''");
}

async function main(): Promise<void> {
  console.log("================================");
  console.log(" CONSTRUCTION ENTREPOT DUCKDB");
  console.log("================================\n");

  await mkdir(WAREHOUSE_DIR, { recursive: true });

  const bronzeDir = join(DATA_DIR, "bronze", "documents");

  const bronzeFiles = (await readdir(bronzeDir))
    .filter(name => name.endsWith(".json"));

  if (bronzeFiles.length === 0) {
    throw new Error("Aucun document Bronze disponible");
  }

  const silverDir = join(DATA_DIR, "silver");

  const invoicesPath = join(silverDir, "invoices.json");
  const linesPath = join(silverDir, "invoice_lines.json");
  const rejectedPath = join(DATA_DIR, "quarantine", "rejected.json");

  const invoices = JSON.parse(
    await readFile(invoicesPath, "utf8")
  ) as unknown[];

  const lines = JSON.parse(
    await readFile(linesPath, "utf8")
  ) as unknown[];

  const rejected = JSON.parse(
    await readFile(rejectedPath, "utf8")
  ) as unknown[];

  if (invoices.length === 0 || lines.length === 0) {
    throw new Error(
      "Silver est vide : impossible de construire l'entrepôt"
    );
  }

  console.log(`[SOURCE] Bronze : ${bronzeFiles.length}`);
  console.log(`[SOURCE] Factures Silver : ${invoices.length}`);
  console.log(`[SOURCE] Lignes Silver : ${lines.length}`);
  console.log(`[SOURCE] Quarantaine : ${rejected.length}`);

  const instance = await DuckDBInstance.create(DB_PATH);
  const db = await instance.connect();

  try {
    await db.run("CREATE SCHEMA IF NOT EXISTS bronze");
    await db.run("CREATE SCHEMA IF NOT EXISTS silver");
    await db.run("CREATE SCHEMA IF NOT EXISTS quality");

    const bronzeJSON = sqlPath(
      join(bronzeDir, "*.json")
    );

    const invoiceJSON = sqlPath(invoicesPath);
    const linesJSON = sqlPath(linesPath);

    const bronzeParquet = sqlPath(
      join(WAREHOUSE_DIR, "bronze_documents.parquet")
    );

    const invoicesParquet = sqlPath(
      join(WAREHOUSE_DIR, "silver_invoices.parquet")
    );

    const linesParquet = sqlPath(
      join(WAREHOUSE_DIR, "silver_invoice_lines.parquet")
    );

    const rejectedParquet = sqlPath(
      join(WAREHOUSE_DIR, "quality_rejected.parquet")
    );

    console.log("\n[BUILD] Bronze Parquet");

    await db.run(`
      COPY (
        SELECT
          CAST(documentId AS VARCHAR) AS document_id,
          CAST(filename AS VARCHAR) AS filename,
          CAST(sha256 AS VARCHAR) AS sha256,
          CAST(source AS VARCHAR) AS source,
          CAST(documentType AS VARCHAR) AS document_type,
          CAST(pageCount AS INTEGER) AS page_count,
          CAST(status AS VARCHAR) AS status,
          CAST(extractedText AS VARCHAR) AS extracted_text,
          CAST(ingestedAt AS VARCHAR) AS ingested_at,
          to_json(pages) AS pages
        FROM read_json_auto(
          '${bronzeJSON}',
          union_by_name = true
        )
      )
      TO '${bronzeParquet}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `);

    console.log("[BUILD] Silver invoices Parquet");

    await db.run(`
      COPY (
        SELECT
          CAST(documentId AS VARCHAR) AS document_id,
          CAST(filename AS VARCHAR) AS filename,
          CAST(invoiceNumber AS VARCHAR) AS invoice_number,
          CAST(supplier AS VARCHAR) AS supplier,
          CAST(supplierSiret AS VARCHAR) AS supplier_siret,
          CAST(client AS VARCHAR) AS client,
          CAST(clientSiret AS VARCHAR) AS client_siret,
          CAST(issueDate AS DATE) AS issue_date,
          CAST(dueDate AS DATE) AS due_date,
          CAST(category AS VARCHAR) AS category,
          CAST(status AS VARCHAR) AS status,
          CAST(paymentMethod AS VARCHAR) AS payment_method,
          CAST(totalHtCents AS BIGINT) AS total_ht_cents,
          CAST(totalVatCents AS BIGINT) AS total_vat_cents,
          CAST(totalTtcCents AS BIGINT) AS total_ttc_cents,
          CAST(extractionMethod AS VARCHAR) AS extraction_method,
          CAST(qualityStatus AS VARCHAR) AS quality_status,
          to_json(qualityIssues) AS quality_issues
        FROM read_json_auto('${invoiceJSON}')
      )
      TO '${invoicesParquet}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `);

    console.log("[BUILD] Silver invoice lines Parquet");

    await db.run(`
      COPY (
        SELECT
          CAST(documentId AS VARCHAR) AS document_id,
          CAST(invoiceNumber AS VARCHAR) AS invoice_number,
          CAST(lineNumber AS INTEGER) AS line_number,
          CAST(description AS VARCHAR) AS description,
          CAST(quantity AS INTEGER) AS quantity,
          CAST(unitPriceCents AS BIGINT) AS unit_price_cents,
          CAST(vatRate AS DOUBLE) AS vat_rate,
          CAST(totalHtCents AS BIGINT) AS total_ht_cents
        FROM read_json_auto('${linesJSON}')
      )
      TO '${linesParquet}'
      (FORMAT PARQUET, COMPRESSION ZSTD);
    `);

    console.log("[BUILD] Quarantaine Parquet");

    if (rejected.length > 0) {
      await db.run(`
        COPY (
          SELECT
            CAST(documentId AS VARCHAR) AS document_id,
            CAST(filename AS VARCHAR) AS filename,
            CAST(invoiceNumber AS VARCHAR) AS invoice_number,
            CAST(supplier AS VARCHAR) AS supplier,
            CAST(qualityStatus AS VARCHAR) AS quality_status,
            to_json(qualityIssues) AS quality_issues
          FROM read_json_auto('${sqlPath(rejectedPath)}')
        )
        TO '${rejectedParquet}'
        (FORMAT PARQUET, COMPRESSION ZSTD);
      `);
    } else {
      await db.run(`
        COPY (
          SELECT
            CAST(NULL AS VARCHAR) AS document_id,
            CAST(NULL AS VARCHAR) AS filename,
            CAST(NULL AS VARCHAR) AS invoice_number,
            CAST(NULL AS VARCHAR) AS supplier,
            CAST(NULL AS VARCHAR) AS quality_status,
            CAST(NULL AS JSON) AS quality_issues
          WHERE FALSE
        )
        TO '${rejectedParquet}'
        (FORMAT PARQUET, COMPRESSION ZSTD);
      `);
    }

    console.log("[BUILD] Vues SQL");

    await db.run(`
      CREATE OR REPLACE VIEW bronze.documents AS
      SELECT * FROM read_parquet('${bronzeParquet}');
    `);

    await db.run(`
      CREATE OR REPLACE VIEW silver.invoices AS
      SELECT * FROM read_parquet('${invoicesParquet}');
    `);

    await db.run(`
      CREATE OR REPLACE VIEW silver.invoice_lines AS
      SELECT * FROM read_parquet('${linesParquet}');
    `);

    await db.run(`
      CREATE OR REPLACE VIEW quality.rejected AS
      SELECT * FROM read_parquet('${rejectedParquet}');
    `);

    const result = await db.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM bronze.documents) AS bronze_count,
        (SELECT COUNT(*) FROM silver.invoices) AS invoice_count,
        (SELECT COUNT(*) FROM silver.invoice_lines) AS line_count,
        (SELECT COUNT(*) FROM quality.rejected) AS rejected_count
    `);

    console.log("\n================================");
    console.log(" BILAN ENTREPOT");
    console.log("================================");

    console.log(
      JSON.stringify(result.getRowObjectsJson(), null, 2)
    );

    console.log(`\nBase DuckDB : ${DB_PATH}`);
    console.log("Stockage analytique : Parquet");
    console.log("Vues : bronze.documents, silver.invoices,");
    console.log("       silver.invoice_lines, quality.rejected");

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
