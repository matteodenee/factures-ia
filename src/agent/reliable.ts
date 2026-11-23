import type { Client } from "@modelcontextprotocol/client";

export type InvoiceFilter = {
  status: "En retard";
  year: number;
};

export type ReliableResult = {
  answer: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
  filter: InvoiceFilter;
};

function getRows(result: unknown): Record<string, unknown>[] {
  const response = result as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };

  if (response.isError) {
    throw new Error("L'outil MCP a retourné une erreur");
  }

  const text = response.content?.find(
    item => item.type === "text"
  )?.text;

  if (!text) {
    throw new Error("Réponse MCP sans contenu");
  }

  const data = JSON.parse(text);

  if (!Array.isArray(data.rows)) {
    throw new Error("Réponse MCP sans tableau rows");
  }

  return data.rows;
}

export async function reliableAnswer(
  client: Client,
  question: string,
  previousFilter: InvoiceFilter | null
): Promise<ReliableResult | null> {
  const normalized = question.toLowerCase();

  const yearMatch = question.match(/\b(20\d{2})\b/);

  const isOverdueSummary =
    /\ben retard\b/.test(normalized) &&
    yearMatch !== null &&
    /combien|nombre|total|montant/.test(normalized);

  if (isOverdueSummary && yearMatch) {
    const year = Number(yearMatch[1]);

    const args: InvoiceFilter = {
      status: "En retard",
      year
    };

    const result = await client.callTool({
      name: "invoice_summary",
      arguments: args
    });

    const rows = getRows(result);
    if (rows.length !== 1) {
      throw new Error("Agrégation MCP inattendue");
    }

    const count = Number(rows[0].invoice_count);
    const total = Number(rows[0].total_ttc_euros);

    if (!Number.isSafeInteger(count) ||
        !Number.isFinite(total)) {
      throw new Error("Valeurs financières invalides");
    }

    const euros = total.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    return {
      answer:
        `En ${year}, ${count} factures sont en retard, ` +
        `pour un montant total TTC de ${euros} €.`,
      tool: "invoice_summary",
      arguments: args,
      result,
      filter: args
    };
  }

  const isFollowUp =
    previousFilter !== null &&
    /leurs?\s+numéros?|quels?\s+sont\s+leurs?/.test(
      normalized
    ) &&
    /clients?/.test(normalized);

  if (isFollowUp && previousFilter) {
    const args = {
      ...previousFilter,
      limit: 100
    };

    const result = await client.callTool({
      name: "list_invoices",
      arguments: args
    });

    const rows = getRows(result);

    const lines = rows.map(row =>
      `- ${String(row.invoice_number)} : ` +
      `${String(row.client)}`
    );

    return {
      answer: rows.length
        ? `Voici les ${rows.length} factures concernées :\n` +
          lines.join("\n")
        : "Aucune facture ne correspond aux filtres.",
      tool: "list_invoices",
      arguments: args,
      result,
      filter: previousFilter
    };
  }

  return null;
}
