import "dotenv/config";

import { DuckDBInstance } from "@duckdb/node-api";
import { join, resolve } from "node:path";

import { validateReadonlySql } from "./sql.js";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");

const WAREHOUSE_DIR = join(DATA_DIR, "warehouse");

const MAX_ROWS = 100;

const DATASETS = [
  {
    schema: "bronze",
    table: "documents",
    file: "bronze_documents.parquet"
  },
  {
    schema: "silver",
    table: "invoices",
    file: "silver_invoices.parquet"
  },
  {
    schema: "silver",
    table: "invoice_lines",
    file: "silver_invoice_lines.parquet"
  },
  {
    schema: "quality",
    table: "rejected",
    file: "quality_rejected.parquet"
  }
] as const;

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export interface SafeQueryResult {
  sql: string;
  rows: unknown[];
  returnedRows: number;
  maxRows: number;
  durationMs: number;
}

export async function executeSafeSql(
  requestedSql: string
): Promise<SafeQueryResult> {
  // Première barrière : validation de la requête.
  const sql = validateReadonlySql(requestedSql);

  // Base temporaire : aucun accès en écriture
  // à l'entrepôt DuckDB permanent.
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    // Configuration avant le verrouillage.
    await connection.run("SET threads = 1");
    await connection.run("SET memory_limit = '256MB'");

    // Chargement initial effectué par notre code de confiance.
    for (const dataset of DATASETS) {
      const path = join(WAREHOUSE_DIR, dataset.file);

      await connection.run(
        `CREATE SCHEMA IF NOT EXISTS ${dataset.schema}`
      );

      await connection.run(`
        CREATE TABLE ${dataset.schema}.${dataset.table} AS
        SELECT *
        FROM read_parquet('${escapeSql(path)}')
      `);
    }

    // Deuxième barrière : plus d'accès aux fichiers
    // ou à d'autres bases externes depuis DuckDB.
    await connection.run(
      "SET enable_external_access = false"
    );

    // Verrouille les paramètres pour la session.
    await connection.run(
      "SET lock_configuration = true"
    );

    // La limite s'applique au résultat renvoyé.
    const limitedSql = `
      SELECT *
      FROM (${sql}) AS validated_query
      LIMIT ${MAX_ROWS}
    `;

    const startedAt = performance.now();

    const result = await connection.runAndReadAll(
      limitedSql
    );

    const rows = result.getRowObjectsJson();

    const durationMs = Math.round(
      performance.now() - startedAt
    );

    return {
      sql,
      rows,
      returnedRows: rows.length,
      maxRows: MAX_ROWS,
      durationMs
    };
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}
