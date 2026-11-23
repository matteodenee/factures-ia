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

  const total = Number(row.total);

  assert.ok(Number.isInteger(total));
  assert.ok(total > 0);

  console.log(
    `[OK] ${total} factures accessibles`
  );
});

test("Exécuteur : calculer le total TTC", async () => {
  const result = await executeSafeSql(`
    SELECT SUM(total_ttc_cents) / 100.0 AS total_euros
    FROM silver.invoices
  `);

  assert.equal(result.rows.length, 1);

  const row = result.rows[0] as {
    total_euros: number | string;
  };

  const totalEuros = Number(row.total_euros);

  assert.ok(Number.isFinite(totalEuros));
  assert.ok(totalEuros >= 0);

  const centsResult = await executeSafeSql(`
    SELECT SUM(total_ttc_cents) AS total_cents
    FROM silver.invoices
  `);

  assert.equal(centsResult.rows.length, 1);

  const centsRow = centsResult.rows[0] as {
    total_cents: number | string;
  };

  const totalCents = Number(centsRow.total_cents);

  assert.ok(Number.isSafeInteger(totalCents));

  assert.ok(
    Math.abs(totalEuros - totalCents / 100) < 0.01
  );

  console.log(
    `[OK] Total TTC : ${totalEuros.toFixed(2)} euros`
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
