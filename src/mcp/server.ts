import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DuckDBInstance } from "@duckdb/node-api";
import { executeSafeSql } from "../security/query.js";
import * as z from "zod/v4";
import { resolve, join } from "node:path";

const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const DB_PATH = join(DATA_DIR, "warehouse", "factures.duckdb");

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function query(sql: string): Promise<unknown[]> {
  const instance = await DuckDBInstance.create(DB_PATH);
  const connection = await instance.connect();

  try {
    const result = await connection.runAndReadAll(sql);
    return result.getRowObjectsJson();
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

function response(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "factures-ia",
    version: "1.0.0"
  });

  server.registerTool(
    "list_invoices",
    {
      description:
        "Lister les factures avec filtres optionnels sur le statut et l'année.",
      inputSchema: z.object({
        status: z.enum([
          "Payée",
          "En retard",
          "En attente"
        ]).optional(),
        year: z.number().int().min(2000).max(2100).optional(),
        limit: z.number().int().min(1).max(100).default(20)
      })
    },
    async ({ status, year, limit }) => {
      const conditions: string[] = [];

      if (status) {
        conditions.push(
          `status = '${escapeSql(status)}'`
        );
      }

      if (year !== undefined) {
        conditions.push(`YEAR(issue_date) = ${year}`);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      const sql = `
        SELECT
          invoice_number,
          supplier,
          client,
          issue_date,
          due_date,
          status,
          total_ttc_cents / 100.0 AS total_ttc_euros
        FROM silver.invoices
        ${where}
        ORDER BY issue_date DESC, invoice_number
        LIMIT ${limit}
      `;

      return response({
        sql,
        rows: await query(sql)
      });
    }
  );

  server.registerTool(
    "invoice_summary",
    {
      description:
        "Calculer directement dans DuckDB le nombre de factures " +
        "et leur montant TTC total, avec filtres optionnels " +
        "sur le statut et l'année. " +
        "Utiliser cet outil pour toutes les questions demandant " +
        "un nombre ou un montant total.",
      inputSchema: z.object({
        status: z.enum([
          "Payée",
          "En retard",
          "En attente"
        ]).optional(),
        year: z.number().int().min(2000).max(2100).optional()
      })
    },
    async ({ status, year }) => {
      const conditions: string[] = [];

      if (status) {
        conditions.push(
          `status = '${escapeSql(status)}'`
        );
      }

      if (year !== undefined) {
        conditions.push(
          `YEAR(issue_date) = ${year}`
        );
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      const sql = `
        SELECT
          COUNT(*) AS invoice_count,
          COALESCE(SUM(total_ttc_cents), 0) / 100.0
            AS total_ttc_euros
        FROM silver.invoices
        ${where}
      `;

      return response({
        sql,
        rows: await query(sql)
      });
    }
  );

  server.registerTool(
    "get_invoice",
    {
      description:
        "Obtenir le détail d'une facture et toutes ses lignes.",
      inputSchema: z.object({
        invoiceNumber: z.string().min(1).max(100)
      })
    },
    async ({ invoiceNumber }) => {
      const identifier = escapeSql(invoiceNumber);

      const invoiceSql = `
        SELECT *
        FROM silver.invoices
        WHERE invoice_number = '${identifier}'
      `;

      const linesSql = `
        SELECT *
        FROM silver.invoice_lines
        WHERE invoice_number = '${identifier}'
        ORDER BY line_number
      `;

      return response({
        invoiceSql,
        linesSql,
        invoices: await query(invoiceSql),
        lines: await query(linesSql)
      });
    }
  );


  server.registerTool(
    "get_schema",
    {
      description:
        "Découvrir les tables, colonnes et types de données de l'entrepôt DuckDB.",
      inputSchema: z.object({
        schema: z.enum([
          "bronze",
          "silver",
          "quality"
        ]).optional()
      })
    },
    async ({ schema }) => {
      const conditions = [
        "table_schema IN ('bronze', 'silver', 'quality')"
      ];

      if (schema) {
        conditions.push(
          `table_schema = '${escapeSql(schema)}'`
        );
      }

      const sql = `
        SELECT
          table_schema,
          table_name,
          column_name,
          data_type,
          ordinal_position
        FROM information_schema.columns
        WHERE ${conditions.join(" AND ")}
        ORDER BY
          table_schema,
          table_name,
          ordinal_position
      `;

      return response({
        sql,
        rows: await query(sql)
      });
    }
  );


  server.registerTool(
    "execute_readonly_sql",
    {
      description:
        "Exécuter une requête SQL SELECT contrôlée sur les factures. " +
        "Tables autorisées : silver.invoices, silver.invoice_lines, " +
        "bronze.documents et quality.rejected. " +
        "Requêtes limitées à 100 lignes. " +
        "Les opérations de modification et les accès externes " +
        "ne sont pas autorisés.",
      inputSchema: z.object({
        sql: z.string().min(1).max(5000)
      })
    },
    async ({ sql }) => {
      try {
        const result = await executeSafeSql(sql);

        return response({
          success: true,
          ...result
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);

        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              sql,
              error: message
            }, null, 2)
          }]
        };
      }
    }
  );

  return server;
}

// stdout est réservé aux messages du protocole MCP.
console.error("[MCP] Serveur factures-ia initialisé");

void serveStdio(createServer);
