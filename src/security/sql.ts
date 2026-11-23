import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;
const parser = new Parser();

const ALLOWED_TABLES = new Set([
  "silver.invoices",
  "silver.invoice_lines",
  "bronze.documents",
  "quality.rejected"
]);

const ALLOWED_FUNCTIONS = new Set([
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "YEAR",
  "COALESCE",
  "ABS",
  "ROUND",
  "LOWER",
  "UPPER"
]);

function getFunctionName(node: Record<string, unknown>): string {
  const name = node.name;

  if (typeof name === "string") {
    return name.toUpperCase();
  }

  if (name && typeof name === "object") {
    const parts = (name as Record<string, unknown>).name;

    if (Array.isArray(parts)) {
      return parts
        .map(part => {
          if (part && typeof part === "object") {
            return String(
              (part as Record<string, unknown>).value ?? ""
            );
          }

          return String(part);
        })
        .join("")
        .toUpperCase();
    }
  }

  return "";
}

function inspectAst(
  value: unknown,
  root = false
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      inspectAst(item);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const node = value as Record<string, unknown>;

  if (node.type === "select" && !root) {
    throw new Error("Sous-requête SQL non autorisée");
  }

  if (
    node.type === "function" ||
    node.type === "aggr_func"
  ) {
    const name = getFunctionName(node);

    if (!ALLOWED_FUNCTIONS.has(name)) {
      throw new Error(
        `Fonction SQL non autorisée : ${name || "inconnue"}`
      );
    }
  }

  for (const [key, child] of Object.entries(node)) {
    // Les références circulaires éventuelles ne sont pas
    // nécessaires à notre validation.
    if (key.startsWith("_")) {
      continue;
    }

    inspectAst(child);
  }
}

export function validateReadonlySql(sql: string): string {
  const normalized = sql.trim();

  if (!normalized) {
    throw new Error("Requête SQL vide");
  }

  if (normalized.length > 5000) {
    throw new Error("Requête SQL trop longue");
  }

  const ast = parser.astify(normalized, {
    database: "postgresql"
  });

  if (Array.isArray(ast)) {
    throw new Error("Une seule requête SQL est autorisée");
  }

  if (ast.type !== "select") {
    throw new Error("Seules les requêtes SELECT sont autorisées");
  }

  const statement = ast as unknown as Record<string, unknown>;

  const into = statement.into as
    | Record<string, unknown>
    | null
    | undefined;

  const hasInto =
    into !== null &&
    into !== undefined &&
    Object.entries(into).some(
      ([key, value]) =>
        key !== "position" &&
        value !== null &&
        value !== undefined
    );

  if (
    statement.with != null ||
    hasInto ||
    statement.set_op != null ||
    statement._next != null
  ) {
    throw new Error(
      "CTE, UNION et opérations SQL complexes non autorisés"
    );
  }

  if (!statement.from) {
    throw new Error(
      "Une table de l'entrepôt doit être utilisée"
    );
  }

  inspectAst(ast, true);

  const tableList = parser.tableList(normalized, {
    database: "postgresql"
  });

  if (tableList.length === 0) {
    throw new Error("Aucune table reconnue");
  }

  for (const entry of tableList) {
    const parts = entry.split("::");

    const table = parts.at(-1)?.toLowerCase() ?? "";
    const schema = parts.at(-2)?.toLowerCase() ?? "";

    const identifier = schema
      ? `${schema}.${table}`
      : table;

    if (!ALLOWED_TABLES.has(identifier)) {
      throw new Error(
        `Accès interdit à la table : ${identifier}`
      );
    }
  }

  return normalized.replace(/;\s*$/, "");
}
