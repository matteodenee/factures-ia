import test from "node:test";
import assert from "node:assert/strict";

import { executeSafeSql } from "../src/security/query.js";

test("Exécuteur : compter les factures", async () => {
  const result = await executeSafeSql(
    "SELECT COUNT(*) AS total FROM silver.invoices"
  );

  assert.equal(result.rows.length, 1);

  const row = result.rows[0] as {
    total: number | string;
  };

  assert.equal(Number(row.total), 10);

  console.log(
    `[OK] ${row.total} factures accessibles`
  );
});

test("Exécuteur : calculer le total TTC", async () => {
  const result = await executeSafeSql(`
    SELECT SUM(total_ttc_cents) / 100.0 AS total_euros
    FROM silver.invoices
  `);

  const row = result.rows[0] as {
    total_euros: number | string;
  };

  assert.ok(
    Math.abs(Number(row.total_euros) - 285089.57) < 0.01
  );

  console.log(
    `[OK] Total TTC : ${row.total_euros} euros`
  );
});

test("Exécuteur : refuser la lecture de fichiers", async () => {
  await assert.rejects(
    executeSafeSql(
      "SELECT read_text('/etc/passwd') FROM silver.invoices"
    )
  );
});

test("Exécuteur : refuser une suppression", async () => {
  await assert.rejects(
    executeSafeSql(
      "DELETE FROM silver.invoices"
    )
  );
});
